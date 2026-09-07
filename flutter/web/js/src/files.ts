import * as message from "./message";
import * as globals from "./globals";
import { initZstd } from "./common";

const MAX_BLOCK = 65536;

interface LocalFile {
  name: string;
  blob: Blob;
  size: number;
}

interface UploadJob {
  id: number;
  files: LocalFile[];
  blockIdx: number;
}

const downloadJobs = new Map<
  number,
  { name: string; parts: Blob[]; size: number; count: number }
>();
const localUploads = new Map<number, UploadJob>();

let filePicker: HTMLInputElement | null = null;
let picked: LocalFile[] = [];

function send(msg: message.DeepPartial<message.Message>) {
  globals.getConn()?._send(msg);
}

function sendFileAction(action: any) {
  send({ file_action: action });
}

function handleDir(dir: message.FileDirectory) {
  const dirs: any[] = [];
  const files: any[] = [];
  for (const e of dir.entries) {
    const isDir =
      e.entry_type === message.FileType.Dir ||
      e.entry_type === message.FileType.DirDrive ||
      e.entry_type === message.FileType.DirLink;
    const rec = {
      name: e.name,
      size: Number(e.size),
      modified: String(e.modified_time || 0),
    };
    if (isDir) {
      rec.size = 0;
      dirs.push(rec);
    } else {
      files.push(rec);
    }
  }
  globals.pushEvent("file_dir", {
    dir: dir.path,
    dirs: JSON.stringify(dirs),
    files: JSON.stringify(files),
  });
}

function toEntries(files: LocalFile[]): message.FileEntry[] {
  return files.map((f) => ({
    name: f.name,
    entry_type: message.FileType.File,
    is_hidden: false,
    size: f.size,
    modified_time: 0,
  }));
}

function handleDigest(d: message.FileTransferDigest) {
  if (d.is_upload) {
    if (d.is_identical) {
      sendFileAction({
        send_confirm: { id: d.id, file_num: d.file_num, skip: true },
      });
    } else {
      globals.pushEvent("override_file_confirm", {
        id: d.id,
        file_num: d.file_num,
        size: d.file_size,
        updated: String(d.last_modified),
        is_upload: true,
      });
    }
    return;
  }
  const job = downloadJobs.get(d.id);
  if (job && d.is_identical) {
    globals.pushEvent("job_done", { id: d.id, file_num: d.file_num });
    downloadJobs.delete(d.id);
  } else if (!job) {
    globals.pushEvent("override_file_confirm", {
      id: d.id,
      file_num: d.file_num,
      size: d.file_size,
      updated: String(d.last_modified),
      is_upload: false,
    });
  }
}

function decompress(data: Uint8Array): Uint8Array {
  const z = (globalThis as any).decompressFrame;
  if (typeof z == "function") return new Uint8Array(z(data));
  const zstd = (globalThis as any).zstd;
  if (zstd && typeof zstd.Decompress == "function") {
    return new Uint8Array(zstd.Decompress(data));
  }
  throw new Error("no zstd decompressor");
}

function handleBlock(b: message.FileTransferBlock) {
  let job = downloadJobs.get(b.id);
  if (!job) {
    job = { name: "job-" + b.id, parts: [], size: 0, count: 0 };
    downloadJobs.set(b.id, job);
  }
  let data: Uint8Array;
  try {
    data = b.compressed ? decompress(b.data) : new Uint8Array(b.data);
  } catch (e) {
    console.warn("decompress failed", e);
    data = new Uint8Array(0);
  }
  job.parts.push(new Blob([data]));
  job.size += data.length;
  job.count += 1;
  globals.pushEvent("job_progress", {
    id: b.id,
    file_num: b.file_num,
    total_size: job.size,
    transferred_size: job.size,
  });
}

function handleDone(d: message.FileTransferDone) {
  const up = localUploads.get(d.id);
  if (up) {
    localUploads.delete(d.id);
    globals.pushEvent("job_done", { id: d.id, file_num: d.file_num });
    return;
  }
  const job = downloadJobs.get(d.id);
  if (job) {
    downloadJobs.delete(d.id);
    const blob = new Blob(job.parts, { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a: any = document.createElement("a");
    a.href = url;
    a.download = job.name.replace(/\//g, "_");
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    globals.pushEvent("job_done", { id: d.id, file_num: d.file_num });
  }
}

function handleError(e: message.FileTransferError) {
  globals.pushEvent("job_error", { id: e.id, file_num: e.file_num, err: e.error });
}

function handleEmptyDirs(r: message.ReadEmptyDirsResponse) {
  globals.pushEvent("empty_dirs", {
    path: r.path,
    dirs: JSON.stringify(r.empty_dirs),
  });
}

function confirmOverride(
  id: number,
  need_override: boolean,
  remember: boolean,
  is_upload: boolean
) {
  if (is_upload) {
    const job = localUploads.get(id);
    sendFileAction({
      send_confirm: { id: id, file_num: 0, skip: !need_override, offset_blk: 0 },
    });
    if (job && need_override) {
      streamAll(id, 0, true);
    }
  } else {
    sendFileAction({
      send_confirm: { id: id, file_num: 0, skip: !need_override, offset_blk: 0 },
    });
  }
  void remember;
}

// ---- upload streaming ----

let zstdReady: Promise<boolean> | null = null;
async function ensureZstd() {
  if (zstdReady === null) {
    zstdReady = initZstd()
      .then(() => true)
      .catch(() => false);
  }
  await zstdReady;
}

async function streamOneFile(job: UploadJob, fileNum: number) {
  const f = job.files[fileNum];
  if (!f) return;
  let offset = 0;
  while (offset < f.size) {
    const end = Math.min(f.size, offset + MAX_BLOCK);
    const buf = new Uint8Array(await f.blob.slice(offset, end).arrayBuffer());
    send({
      file_response: {
        block: { id: job.id, file_num: fileNum, data: buf, compressed: false, blk_id: Math.floor(offset / MAX_BLOCK) },
      },
    });
    offset = end;
    globals.pushEvent("job_progress", {
      id: job.id,
      file_num: fileNum,
      total_size: f.size,
      transferred_size: offset,
    });
  }
  sendFileAction({
    send_confirm: { id: job.id, file_num: fileNum + 1, offset_blk: 0 },
  });
  if (fileNum + 1 >= job.files.length) {
    send({
      file_response: { done: { id: job.id, file_num: fileNum } },
    });
    globalThis.setTimeout(() => globals.pushEvent("job_done", { id: job.id, file_num: fileNum }), 50);
    localUploads.delete(job.id);
  } else {
    await streamAll(job.id, fileNum + 1, false);
  }
}

async function streamAll(id: number, fileNum: number, restart: boolean) {
  const job = localUploads.get(id);
  if (!job) return;
  await ensureZstd();
  await streamOneFile(job, fileNum);
  void restart;
}

export const files = {
  readRemoteDir(path: string, include_hidden: boolean) {
    send({
      file_action: { read_dir: { path: path, include_hidden: include_hidden } },
    });
  },

  uploadFiles(value: any) {
    const id = value.id || Date.now();
    const names: string[] = value.files || [];
    const items: LocalFile[] = [];
    for (const n of names) {
      const p = picked.find((x) => x.name == n || x.name.endsWith("/" + n));
      if (p) items.push(p);
    }
    if (!items.length) {
      globals.pushEvent("job_error", { id, file_num: 0, err: "No files picked" });
      return;
    }
    const up: UploadJob = {
      id,
      files: items,
      blockIdx: 0,
    };
    localUploads.set(id, up);
    const path: string = value.path || "";
    const total = items.reduce((s, f) => s + f.size, 0);
    send({
      file_action: {
        receive: { id, path, files: toEntries(items), file_num: items.length, total_size: total },
      },
    });
  },

  confirmOverride(id: number, need_override: boolean, remember: boolean, is_upload: boolean) {
    confirmOverride(id, need_override, remember, is_upload);
  },

  removeFile(value: any) {
    sendFileAction({
      remove_file: { id: value.id || 0, path: value.path || "", file_num: 0 },
    });
    void value;
  },

  readDirToRemoveRecursive(value: any) {
    send({ file_action: { remove_dir: { id: value.id || 0, path: value.path || "", recursive: true } } });
    void value;
  },

  removeAllEmptyDirs(value: any) {
    send({ file_action: { read_empty_dirs: { path: value.path || "", include_hidden: false } } });
    void value;
  },

  cancelJob(id: number) {
    send({ file_action: { cancel: { id } } });
  },

  createDir(value: any) {
    send({ file_action: { create: { id: value.id || 0, path: value.path || "" } } });
    void value;
  },

  renameFile(value: any) {
    sendFileAction({
      rename: { id: value.id || 0, path: value.path || "", new_name: value.new_name || "" },
    });
    void value;
  },

  selectFiles() {
    if (!filePicker) {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.style.display = "none";
      input.addEventListener("change", () => {
        picked = [];
        for (const f of Array.from(input.files || [])) {
          picked.push({ name: f.name, blob: f, size: f.size });
        }
      });
      document.body.appendChild(input);
      filePicker = input;
    }
    filePicker.click();
  },

  handleFileResponse(fr: message.FileResponse) {
    if (fr.dir) {
      handleDir(fr.dir);
    } else if (fr.digest) {
      handleDigest(fr.digest);
    } else if (fr.block) {
      handleBlock(fr.block);
    } else if (fr.done) {
      handleDone(fr.done);
    } else if (fr.error) {
      handleError(fr.error);
    } else if (fr.empty_dirs) {
      handleEmptyDirs(fr.empty_dirs);
    }
  },
};