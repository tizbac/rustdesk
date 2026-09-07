#!/usr/bin/env python

import os

path = os.path.abspath(os.path.join(os.getcwd(), '..', '..', '..', 'libs', 'hbb_common', 'protos'))

if os.name == 'nt':
    cmd = r'protoc --ts_proto_opt=esModuleInterop=true --ts_proto_opt=snakeToCamel=false --plugin=protoc-gen-ts_proto=.\node_modules\.bin\protoc-gen-ts_proto.cmd  -I "%s" --ts_proto_out=./src/ rendezvous.proto'%path
    print(cmd)
    os.system(cmd)
    cmd = r'protoc --ts_proto_opt=esModuleInterop=true --ts_proto_opt=snakeToCamel=false --plugin=protoc-gen-ts_proto=.\node_modules\.bin\protoc-gen-ts_proto.cmd  -I "%s" --ts_proto_out=./src/ message.proto'%path
    print(cmd)
    os.system(cmd)
else:
    cmd = r'protoc --ts_proto_opt=esModuleInterop=true --ts_proto_opt=snakeToCamel=false --plugin=./node_modules/.bin/protoc-gen-ts_proto -I "%s" --ts_proto_out=./src/ rendezvous.proto'%path
    print(cmd)
    os.system(cmd)
    cmd = r'protoc --ts_proto_opt=esModuleInterop=true --ts_proto_opt=snakeToCamel=false --plugin=./node_modules/.bin/protoc-gen-ts_proto -I "%s" --ts_proto_out=./src/ message.proto'%path
    print(cmd)
    os.system(cmd)

# ts-proto emits "globalThis.Buffer", "globalThis.String", "globalThis.atob",
# "globalThis.btoa" in bytesFromBase64/base64FromBytes, which TS 4.9
# cannot index-check on "typeof globalThis". Keep the code identical at
# runtime, only loosen the type.
for f in ['./src/message.ts', './src/rendezvous.ts']:
    text = open(f).read()
    for a, b in [
        ('return Uint8Array.from(globalThis.Buffer.from(b64, "base64"));',
         'return Uint8Array.from((globalThis as any).Buffer.from(b64, "base64"));'),
        ('return globalThis.Buffer.from(arr).toString("base64");',
         'return (globalThis as any).Buffer.from(arr).toString("base64");'),
        ('const bin = globalThis.atob(b64);',
         'const bin = (globalThis as any).atob(b64);'),
        ('return globalThis.btoa(bin.join(""));',
         'return (globalThis as any).btoa(bin.join(""));'),
        ('bin.push(globalThis.String.fromCharCode(byte));',
         'bin.push((globalThis as any).String.fromCharCode(byte));'),
    ]:
        text = text.replace(a, b)
    open(f, 'w').write(text)