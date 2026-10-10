# Verify a pyre-agent install

Follow these steps after `python3 install.py` to confirm that the skills and global instructions on this machine match the commit that was installed. Run every step on the machine that ran the install, in bash, from the root of the repository checkout.

The steps only read files and run dry runs. Report each finding to the user and ask before you fix it. Do not run `--force` or `uninstall`, and do not edit an instruction file, without the user's approval.

## Set up the shell

Define these names once:

```bash
claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
codex_dir="${CODEX_HOME:-$HOME/.codex}"
codex_skills="$HOME/.agents/skills"
record="${XDG_STATE_HOME:-$HOME/.local/state}/pyre-agent/install.json"
installed() { python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["hosts"][sys.argv[2]]["commit"])' "$record" "$1"; }
```

If `$record` does not exist, nothing is installed. Stop and report that. If `installed codex` or `installed claude-code` fails, that host was not installed. Skip its checks and report the missing host.

## 1. Read the installed state

```bash
python3 install.py status --offline
```

Expect exit code 0. Each host line names the installed ref and commit. No skill shows `missing` or `edited locally`, and each `instructions` line ends with `up to date`.

A note such as `main has 1.1.0`, or `main has different instructions`, is not a failure. It means `main` changed after the install. Offer to run the install again.

## 2. Confirm that a reinstall changes nothing

Plan a reinstall of the exact installed commit for each host:

```bash
python3 install.py --dry-run --offline --host claude-code --ref "$(installed claude-code)"
python3 install.py --dry-run --offline --host codex --ref "$(installed codex)"
```

Expect exit code 0 from both. Each host prints `N up to date` and `instructions ...: up to date`. Any line that starts with `install`, `update`, `adopt`, `remove`, `unlink`, `conflict`, or `edited` is a finding.

## 3. Compare the installed skills with the commit

This step does not rely on `install.py`. It extracts the installed commit with Git and compares each skill folder byte for byte:

```bash
compare_skills() {  # usage: compare_skills COMMIT DESTINATION SOURCE_FOLDER...
  local commit=$1 dest=$2 tree src name
  shift 2
  tree=$(mktemp -d)
  git archive "$commit" skills host-skills | tar -x -C "$tree"
  for folder in "$@"; do
    for src in "$tree/$folder"/*/; do
      name=$(basename "$src")
      if [ -L "$dest/$name" ]; then echo "SYMLINK $dest/$name"
      elif diff -r "$src" "$dest/$name" >/dev/null 2>&1; then echo "ok $name"
      else echo "DIFFERS $dest/$name"; fi
    done
  done
  rm -rf "$tree"
}
compare_skills "$(installed claude-code)" "$claude_dir/skills" skills host-skills/claude-code
compare_skills "$(installed codex)" "$codex_skills" skills
```

Expect only `ok` lines. `DIFFERS` means the installed copy is missing or changed. `SYMLINK` means a skill is still linked instead of copied. Run `diff -r` on a `DIFFERS` folder to show the user what changed.

## 4. Look for leftover and duplicate skills

Find symlinks into this checkout, which the earlier README steps created:

```bash
find "$claude_dir/skills" "$codex_skills" -maxdepth 1 -type l -lname "$PWD/*"
```

Expect no output. The install replaces or removes these links, so any line is a finding.

Find skill names that are in both Codex skill folders:

```bash
ls "$codex_dir/skills" 2>/dev/null | grep -Fx -f <(ls "$codex_skills")
```

Codex documents only `~/.agents/skills`, but older installs used `~/.codex/skills`, and Codex shows each copy of a duplicated skill. A pyre-agent skill name in this output is a finding. Names that belong to other tools, such as `omarchy` on an Omarchy machine, are not.

## 5. Check the instruction blocks

Each instruction file must hold exactly one block, and the block must equal `global/AGENTS.md` at the installed commit:

```bash
check_block() {  # usage: check_block FILE COMMIT
  echo "$1: $(grep -c '^<!-- pyre-agent:begin' "$1") begin, $(grep -c '^<!-- pyre-agent:end -->$' "$1") end"
  sed -n '/^<!-- pyre-agent:begin/,/^<!-- pyre-agent:end -->$/p' "$1" | sed '1d;$d' \
    | diff - <(git show "$2:global/AGENTS.md") && echo "block matches ${2:0:12}"
}
check_block "$claude_dir/CLAUDE.md" "$(installed claude-code)"
check_block "$codex_dir/AGENTS.md" "$(installed codex)"
```

Expect `1 begin, 1 end` and `block matches` for each file. Any other count, or diff output, is a finding.

Codex reads a non-empty `AGENTS.override.md` instead of `AGENTS.md`:

```bash
if [ -s "$codex_dir/AGENTS.override.md" ]; then echo "override: $codex_dir/AGENTS.override.md"; fi
```

Expect no output.

## 6. Review the text kept after each block

Text after the end marker belongs to the user. The first install keeps sections whose headings `global/AGENTS.md` lacks, so they can repeat the block under another heading. Print the kept text, then the lines that appear both inside and after the block:

```bash
review_kept() {  # usage: review_kept FILE
  echo "== $1"
  sed -n '/^<!-- pyre-agent:end -->$/,$p' "$1" | sed 1d
  echo "-- lines repeated from the block:"
  comm -12 <(sed -n '/^<!-- pyre-agent:begin/,/^<!-- pyre-agent:end -->$/p' "$1" | grep -v '^[[:space:]]*$' | sort -u) \
           <(sed -n '/^<!-- pyre-agent:end -->$/,$p' "$1" | sed 1d | grep -v '^[[:space:]]*$' | sort -u)
}
review_kept "$claude_dir/CLAUDE.md"
review_kept "$codex_dir/AGENTS.md"
```

Report every repeated line with the section it sits in. Also read the kept sections for rules that repeat or contradict the block in different words, and report those. Do not delete kept text without approval.

A first install into an existing file leaves a backup. List the backups so that the report can name them:

```bash
ls "$claude_dir"/CLAUDE.md.pyre-backup-* "$codex_dir"/AGENTS.md.pyre-backup-* 2>/dev/null
```

## 7. Check that a new session loads them

This session loaded its skills and instructions before the install, so it cannot show the result. Ask the user before you start a new session, because it runs a model. Then, in a new Claude Code session and a new Codex session:

1. Ask for the names of the available skills. Expect each pyre-agent skill once. `correct`, `deliver-draft-pr`, and `codex-branch-review` can be absent from the list, because the hosts hide them until you invoke them by name.
2. Ask for the first heading of the global instructions. Expect `# Working with Zak`.
3. Invoke one skill by name: `/unslop` in Claude Code, or `$unslop` in Codex. Expect the skill to load.

If the user does not approve, report this step as not run.

## Report the result

Lead with one line: the install passes, or it has findings. Then give each step with its result, including any step you did not run. For each finding, give the path, what differs, and the fix you propose. Name the backup files from step 6.

## Fix common findings

Propose these fixes to the user. Apply a fix only after the user approves it.

| Finding | Likely cause | Proposed fix |
| --- | --- | --- |
| `conflict` for a skill | Another tool already has a folder with that name. | Show the folder and what owns it. Ask the user whether to rename or remove it, then run the install again. |
| `edited`, or `DIFFERS`, for a skill | Someone changed the installed copy. | Show `diff -r`. Ask whether to move the edit into the repository or to discard it with `python3 install.py --force`. |
| `instructions ...: conflict` | The first install found a section with the same heading and different text. | Show the diff that the install printed. Ask which version to keep, edit the user's file, and run the install again. |
| `edited` for instructions, or a block diff in step 5 | Someone changed text inside the block. | Show the diff. Ask whether to move the change into `global/AGENTS.md` or to discard it with `--force`. |
| Marker counts other than `1 begin, 1 end` | Someone edited or copied a marker line. | Show the marker lines. Ask the user before you repair them. |
| A symlink into the checkout in step 4 | An earlier README install is still present. | Run the install again. It replaces or removes these links. |
| A pyre-agent skill in both Codex folders | An older install used `~/.codex/skills`. | Ask the user before you remove the copy in `~/.codex/skills`. |
| A non-empty `AGENTS.override.md` | The user, or another tool, created it. | Tell the user that Codex ignores `AGENTS.md` while the override exists. |

## Roll back

To remove everything the installer added, with the user's approval:

```bash
python3 install.py uninstall
```

`uninstall` removes the installed skills and the blocks, and it deletes instruction files that the install created. To return a merged file to its state before the first install, copy its backup over it:

```bash
cp "$codex_dir/AGENTS.md.pyre-backup-<timestamp>" "$codex_dir/AGENTS.md"
```
