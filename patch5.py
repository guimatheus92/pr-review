import io

def sub(path, old, new):
    s = io.open(path, encoding="utf8").read()
    assert old in s, f"NOT FOUND in {path}: {old[:80]}"
    io.open(path, "w", encoding="utf8", newline="\n").write(s.replace(old, new))
    print("patched", path)

sub("src/commands/packs.ts",
    "import { existsSync } from 'node:fs';",
    "import { existsSync, statSync } from 'node:fs';")
sub("src/commands/packs.ts",
    "import { linguistCachePath, loadLinguist } from '../stack/linguist.js';",
    "import { linguistCachePath, loadLinguist } from '../stack/linguist.js';\nimport { maskUrl } from '../stack/detect.js';")
sub("src/commands/packs.ts",
    "not cloned yet (${pack.git});",
    "not cloned yet (${maskUrl(pack.git)});")
sub("src/commands/doctor.ts",
    "      bad(`pack ${pack.name}`, `not cloned (${pack.git}) — clones on the next review, or run \`pr-review packs sync\`` );",
    "PLACEHOLDER-NEVER-MATCHES")
