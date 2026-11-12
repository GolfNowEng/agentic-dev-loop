/**
 * PreToolUse hook checker invoked by `.claude/hooks/block-unsafe-git.sh` for
 * every Bash call. Makes design constraint A4 ("no force push, no
 * `--force-with-lease`, no `gh stack push/sync/submit`") and the "hooks are
 * never bypassed" rule (`--no-verify` / `-n`) a runtime guard instead of
 * prompt text.
 *
 * Exit codes (process level, same convention as the sibling checkers):
 *   0 -- nothing unsafe found.
 *   3 -- an unsafe git/gh invocation was found. stdout carries the name of
 *        the rule that matched (a fixed string from this file, never any
 *        part of the command), for the hook's denial message.
 *   2 -- the check could not be completed: malformed stdin, a command the
 *        tokenizer cannot parse (unterminated quote/substitution), or an
 *        argument whose value is only known at run time (`git push
 *        "$FLAGS"`) in a position where it could be a banned flag. stdout
 *        carries a fixed reason string. The hook denies on this too.
 *
 * How it decides (see the task-5 report for the full case list):
 *   1. The command string is tokenized the way a POSIX shell would split
 *      it: quotes, backslash escapes, `;` `&` `|` `&&` `||` newlines,
 *      `( )` subshells, redirections, heredocs (quoted bodies are data;
 *      unquoted bodies are scanned for substitutions), and `$( )` / backtick
 *      / `<( )` substitutions, whose contents are tokenized recursively as
 *      commands of their own. Quote removal happens, so `g'i't push -f` is
 *      `git push -f`.
 *   2. Each simple command has its leading `NAME=value` assignments and
 *      reserved words (`{`, `!`, `then`, `do`, ...) dropped, then wrappers
 *      are unwrapped: `env`, `command`, `exec`, `nohup`, `sudo`, `nice`,
 *      `timeout`, `time`, `xargs`, `direnv exec <dir>`, `find ... -exec/
 *      -execdir/-ok/-okdir ... ;|+` (like xargs: a git push/commit or gh
 *      stack there is unverifiable), ... and `bash/sh/zsh -c '<script>'`
 *      and `eval <args>`, whose script text is analyzed recursively.
 *      `direnv` with any other subcommand is not a wrapper.
 *   2a. Hook bypass through the environment: any assignment (leading,
 *      via `env`, or `export`/`declare`/`typeset`/`readonly`/`local`) of
 *      `HUSKY` or `HUSKY_SKIP_HOOKS` is denied, whatever its value and
 *      whether or not a git command follows; so is any `GIT_CONFIG_*`
 *      (`GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_PARAMETERS`, ...) whose value
 *      mentions `hookspath` (any case). A `GIT_CONFIG_PARAMETERS` or
 *      `GIT_CONFIG_KEY_<n>` value only known at run time is unverifiable.
 *   2b. Variables set without an assignment word: `printf -v NAME`, `read
 *      [-a] NAME...`, `mapfile`/`readarray [NAME]` naming HUSKY or
 *      HUSKY_SKIP_HOOKS are denied; naming GIT_CONFIG_PARAMETERS or
 *      GIT_CONFIG_KEY_<n> is unverifiable (the value is only known at run
 *      time). This runs before the NEVER_EXECUTES_ARGS exemption below
 *      (`printf` is in it). A `mapfile -C <callback>` is analyzed as a script.
 *   2c. Any other command name is not unwrapped. If its arguments contain
 *      a `git` word followed later by `push` or `commit`, or a `gh` word
 *      followed later by `stack` (`npx git push`, `npm exec -- git commit`,
 *      `pnpm exec`, `yarn`, ...), or any single argument, tokenized as a
 *      script of its own, contains such a call (`watch 'git push -f'`, `ssh
 *      host '...'`, `npx sh -c '...'`, `tmux new '...'`; an argument that
 *      does not tokenize falls back to a substring test), the command is
 *      unverifiable (exit 2): this checker cannot know whether that command
 *      runs its arguments. Commands that never run their arguments (`echo`,
 *      `printf`, `grep`, `rg`, `cat`, `jq`, ...: NEVER_EXECUTES_ARGS) are
 *      exempt, and so is git's own argument list (`git commit -m '...'` is
 *      parsed by the git rules below).
 *   2d. A shell (`bash`/`sh`/...) with no `-c` and no script-file operand
 *      (or with `-s` / `-`) reads its script from stdin. A here-string, a
 *      heredoc (quoted body as is; an unquoted body only when it has no `$`
 *      or backtick expansions), or a pipe from a literal `echo`/`printf`
 *      (no expansions, no backslash escapes, no `%` directives, no `echo
 *      -e`) is analyzed as a script by content. Any other stdin (a file
 *      redirect, `cat f |`, `curl ... |`, another producer, a compound
 *      command, an inherited stdin, a shell run by xargs) is unverifiable.
 *   3. `git` is parsed past its global options (`-C`, `-c`, `--git-dir`,
 *      ...) to the subcommand. `push` and `commit` get an argument parser
 *      that knows which of their options take a value, so `-n` is denied
 *      only as a flag of commit/push (never as `-m -n`'s message, and never
 *      for `git grep -n` / `git log -n`). Long options match by prefix, the
 *      way git accepts unambiguous abbreviations (`--forc`).
 *   4. `gh stack push|sync|submit` (and their prefixes) are denied;
 *      `gh stack link/view/init/...` are not.
 *
 * When in doubt it denies. The command string is handled purely as data:
 * nothing here executes, evals or interpolates it.
 *
 * Known residuals (a command-string denylist cannot close these; they rest
 * on the skills' "never bypass a hook" rule and on review):
 *   - Interpreter one-liners and scripts: `python3 -c "os.system('git push
 *     -f')"`, `node -e ...`, `perl -e ...`, a script file written first and
 *     run after. Their code is not shell and is not parsed here.
 *   - Disabling the hooks on disk: `rm -rf .git/hooks`, `rm .husky/pre-push`,
 *     `chmod -x .husky/pre-commit`, overwriting a hook file with an editor
 *     or `>` redirection, editing `.git/config` directly.
 *   - git's own exec hooks (`rebase --exec`, `submodule foreach`, `bisect
 *     run`), and a shell given a script-file operand (`bash script.sh`).
 *   - Anything whose text only exists at run time beyond the cases above
 *     (a command read from a file, `source`d scripts, aliases defined
 *     elsewhere).
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The command could not be verified (exit 2). */
export class Unverifiable extends Error {}

interface Word {
  value: string;
  /** Any quoting at all (affects reserved-word and heredoc handling). */
  quoted: boolean;
  /** Contains a run-time expansion ($VAR, $(...), `...`). */
  expansion: boolean;
  /** An expansion occurs before any literal character: the word's start is unknown. */
  leadingExpansion: boolean;
}

class WordBuilder {
  value = "";
  quoted = false;
  expansion = false;
  leadingExpansion = false;
  add(text: string): void {
    this.value += text;
  }
  expand(): void {
    if (this.value === "" && !this.expansion) this.leadingExpansion = true;
    this.expansion = true;
  }
  finish(): Word {
    return { value: this.value, quoted: this.quoted, expansion: this.expansion, leadingExpansion: this.leadingExpansion };
  }
}

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
  quoted: boolean;
  /** Filled in once the body has been read (tabs already stripped for `<<-`). */
  body?: string;
}

/**
 * Where a simple command's stdin comes from, as far as the tokenizer can
 * tell. `inherit` is also used for "unknown" (inside a `( )` subshell, after
 * a reserved word): a shell reading a script from it is unverifiable.
 */
type Stdin =
  | { kind: "inherit" }
  | { kind: "file" }
  | { kind: "herestring"; word: Word }
  | { kind: "heredoc"; doc: PendingHeredoc }
  /** `from` is the producer's words, or null when it was a compound command (`( )`, `{ }`, ...). */
  | { kind: "pipe"; from: Word[] | null };

const INHERIT: Stdin = { kind: "inherit" };

interface SimpleCommand {
  words: Word[];
  stdin: Stdin;
}

/**
 * Splits a shell command string into simple commands. Every simple command
 * found anywhere (including inside substitutions) lands in `commands`.
 */
class Tokenizer {
  pos = 0;
  private pendingHeredocs: PendingHeredoc[] = [];

  private readonly s: string;
  readonly commands: SimpleCommand[];
  private readonly depth: number;

  // Plain fields, not parameter properties: Node runs this file with
  // type-stripping only, which rejects parameter properties.
  constructor(s: string, commands: SimpleCommand[] = [], depth = 0) {
    if (depth > 32) throw new Unverifiable("nesting too deep");
    this.s = s;
    this.commands = commands;
    this.depth = depth;
  }

  run(): SimpleCommand[] {
    this.parseList(null);
    return this.commands;
  }

  /**
   * Parses commands until end of input, or until the unmatched `)` that
   * closes a `$(` / `<(` when `stop` is ")".
   */
  parseList(stop: ")" | null): void {
    const s = this.s;
    let cur: Word[] = [];
    let curStdin: Stdin = INHERIT;
    let w: WordBuilder | null = null;
    let subshellDepth = 0;
    // The next word is a redirection target ("drop"), or a here-string fed to stdin ("herestring").
    let redirectTarget: "drop" | "herestring" | null = null;
    let heredocNext: { stripTabs: boolean; toStdin: boolean } | null = null;

    const endWord = (): void => {
      if (w === null) return;
      const word = w.finish();
      w = null;
      if (heredocNext !== null) {
        const doc: PendingHeredoc = { delimiter: word.value, stripTabs: heredocNext.stripTabs, quoted: word.quoted };
        this.pendingHeredocs.push(doc);
        if (heredocNext.toStdin) curStdin = { kind: "heredoc", doc };
        heredocNext = null;
        return;
      }
      if (redirectTarget !== null) {
        if (redirectTarget === "herestring") curStdin = { kind: "herestring", word };
        redirectTarget = null;
        return;
      }
      cur.push(word);
    };
    const endCommand = (): void => {
      endWord();
      if (cur.length > 0) {
        // A pipe into `{ ...; }`, `if`, `while`, ...: a redirect on the compound
        // command (`{ sh; } < f`) can replace it, and the tokenizer does not
        // track that: unknown.
        const intoCompound = curStdin.kind === "pipe" && RESERVED.has(cur[0].value) && !cur[0].quoted && !cur[0].expansion;
        this.commands.push({ words: cur, stdin: intoCompound ? INHERIT : curStdin });
      }
      cur = [];
      curStdin = INHERIT;
    };
    const word = (): WordBuilder => (w ??= new WordBuilder());

    while (this.pos < s.length) {
      const c = s[this.pos];
      const next = s[this.pos + 1];

      if (c === "\\") {
        if (next === "\n") {
          this.pos += 2; // line continuation
          continue;
        }
        const b = word();
        b.quoted = true;
        b.add(next ?? "\\");
        this.pos += next === undefined ? 1 : 2;
        continue;
      }
      if (c === "'") {
        const end = s.indexOf("'", this.pos + 1);
        if (end === -1) throw new Unverifiable("unterminated single quote");
        const b = word();
        b.quoted = true;
        b.add(s.slice(this.pos + 1, end));
        this.pos = end + 1;
        continue;
      }
      if (c === '"') {
        this.readDoubleQuoted(word());
        continue;
      }
      if (c === "`") {
        word().expand();
        this.readBacktick();
        continue;
      }
      if (c === "$") {
        this.readDollar(word());
        continue;
      }
      if (c === "#" && w === null) {
        const nl = s.indexOf("\n", this.pos);
        this.pos = nl === -1 ? s.length : nl;
        continue;
      }
      if (c === "\n") {
        // `a |<newline>b` is still one pipeline.
        const pendingPipe = cur.length === 0 && w === null && curStdin.kind === "pipe" ? curStdin : null;
        endCommand();
        if (pendingPipe !== null) curStdin = pendingPipe;
        this.pos += 1;
        this.readHeredocBodies();
        continue;
      }
      if (c === " " || c === "\t" || c === "\r") {
        endWord();
        this.pos += 1;
        continue;
      }
      if (c === "&" && next === ">") {
        endWord();
        this.pos += 2;
        if (s[this.pos] === ">") this.pos += 1;
        redirectTarget = "drop";
        continue;
      }
      if (c === "|" && next !== "|") {
        // A pipe (`|` or `|&`): the next command's stdin is this command's output.
        endWord();
        const producer = cur.length > 0 ? cur : null;
        endCommand();
        curStdin = { kind: "pipe", from: producer };
        this.pos += next === "&" ? 2 : 1;
        continue;
      }
      if (c === "|") {
        endCommand();
        this.pos += 2; // `||`
        continue;
      }
      if (c === ";" || c === "&") {
        endCommand();
        this.pos += 1;
        continue;
      }
      if (c === "(") {
        endCommand();
        subshellDepth += 1;
        this.pos += 1;
        continue;
      }
      if (c === ")") {
        endCommand();
        this.pos += 1;
        if (subshellDepth > 0) {
          subshellDepth -= 1;
          continue;
        }
        if (stop === ")") return;
        continue;
      }
      if (c === "<" || c === ">") {
        // `2>`: a bare digit word right before a redirection is its fd.
        let fd: string | null = null;
        if (w !== null && /^\d+$/.test(w.value) && !w.quoted && !w.expansion) {
          fd = w.value;
          w = null;
        } else endWord();
        const toStdin = c === "<" ? fd === null || /^0+$/.test(fd) : fd !== null && /^0+$/.test(fd);
        if (next === "(") {
          // Process substitution: its contents run as commands.
          this.pos += 2;
          this.parseList(")");
          const b = word();
          b.expand();
          continue;
        }
        if (s.startsWith("<<<", this.pos)) {
          this.pos += 3;
          redirectTarget = toStdin ? "herestring" : "drop";
          continue;
        }
        if (s.startsWith("<<", this.pos)) {
          this.pos += 2;
          const stripTabs = s[this.pos] === "-";
          if (stripTabs) this.pos += 1;
          heredocNext = { stripTabs, toStdin };
          continue;
        }
        this.pos += 1;
        while (this.pos < s.length && ">&|".includes(s[this.pos])) this.pos += 1;
        if (toStdin) curStdin = { kind: "file" }; // `< f`, `0< f`, `<> f`, `<&3`: a script only known at run time
        redirectTarget = "drop";
        continue;
      }
      word().add(c);
      this.pos += 1;
    }

    endCommand();
    if (this.pendingHeredocs.length > 0) this.readHeredocBodies();
    if (stop !== null) throw new Unverifiable("unterminated substitution");
  }

  private readDoubleQuoted(b: WordBuilder): void {
    const s = this.s;
    b.quoted = true;
    this.pos += 1;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === '"') {
        this.pos += 1;
        return;
      }
      if (c === "\\") {
        const next = s[this.pos + 1];
        if (next !== undefined && '$`"\\\n'.includes(next)) {
          if (next !== "\n") b.add(next);
          this.pos += 2;
        } else {
          b.add("\\");
          this.pos += 1;
        }
        continue;
      }
      if (c === "$") {
        this.readDollar(b);
        continue;
      }
      if (c === "`") {
        b.expand();
        this.readBacktick();
        continue;
      }
      b.add(c);
      this.pos += 1;
    }
    throw new Unverifiable("unterminated double quote");
  }

  private readDollar(b: WordBuilder): void {
    const s = this.s;
    const next = s[this.pos + 1];
    if (next === "(") {
      b.expand();
      this.pos += 2;
      this.parseList(")"); // `$((` arithmetic parses as a nested subshell: harmless
      return;
    }
    if (next === "{") {
      b.expand();
      let depth = 0;
      let i = this.pos + 1;
      for (; i < s.length; i++) {
        if (s[i] === "{") depth += 1;
        else if (s[i] === "}" && --depth === 0) break;
      }
      if (i >= s.length) throw new Unverifiable("unterminated ${...}");
      const inner = s.slice(this.pos + 2, i);
      if (inner.includes("$(") || inner.includes("`")) throw new Unverifiable("command substitution inside ${...}");
      this.pos = i + 1;
      return;
    }
    if (next === "'") {
      // ANSI-C quoting: escapes (\x2d, \055, ...) can spell anything.
      let i = this.pos + 2;
      let text = "";
      let escaped = false;
      for (; i < s.length && s[i] !== "'"; i++) {
        if (s[i] === "\\") {
          escaped = true;
          i += 1;
        }
        text += s[i] ?? "";
      }
      if (i >= s.length) throw new Unverifiable("unterminated $'...'");
      b.quoted = true;
      if (escaped) b.expand();
      else b.add(text);
      this.pos = i + 1;
      return;
    }
    if (next === '"') {
      this.pos += 1;
      this.readDoubleQuoted(b);
      return;
    }
    if (next !== undefined && /[A-Za-z_]/.test(next)) {
      b.expand();
      this.pos += 1;
      while (this.pos < s.length && /[A-Za-z0-9_]/.test(s[this.pos])) this.pos += 1;
      return;
    }
    if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
      b.expand();
      this.pos += 2;
      return;
    }
    b.add("$");
    this.pos += 1;
  }

  private readBacktick(): void {
    const s = this.s;
    let i = this.pos + 1;
    let inner = "";
    for (; i < s.length && s[i] !== "`"; i++) {
      if (s[i] === "\\" && i + 1 < s.length && "`\\$".includes(s[i + 1])) {
        inner += s[i + 1];
        i += 1;
      } else {
        inner += s[i];
      }
    }
    if (i >= s.length) throw new Unverifiable("unterminated backtick");
    this.pos = i + 1;
    new Tokenizer(inner, this.commands, this.depth + 1).run();
  }

  private readHeredocBodies(): void {
    const s = this.s;
    for (const doc of this.pendingHeredocs) {
      let body = "";
      while (this.pos < s.length) {
        const nl = s.indexOf("\n", this.pos);
        const end = nl === -1 ? s.length : nl;
        const line = s.slice(this.pos, end);
        this.pos = nl === -1 ? s.length : nl + 1;
        const stripped = doc.stripTabs ? line.replace(/^\t+/, "") : line;
        if (stripped === doc.delimiter) break;
        body += stripped + "\n";
      }
      doc.body = body;
      if (!doc.quoted) this.scanForSubstitutions(body);
    }
    this.pendingHeredocs = [];
  }

  /** An unquoted heredoc body is data, except for the substitutions in it. */
  private scanForSubstitutions(text: string): void {
    const sub = new Tokenizer(text, this.commands, this.depth + 1);
    const sink = new WordBuilder();
    while (sub.pos < text.length) {
      const c = text[sub.pos];
      if (c === "\\") sub.pos += 2;
      else if (c === "$") sub.readDollar(sink);
      else if (c === "`") sub.readBacktick();
      else sub.pos += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Command analysis
// ---------------------------------------------------------------------------

const RESERVED = new Set(["{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "time", "in", "coproc"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
/** Wrappers that run their remaining arguments as a command, with the options that take a separate value. */
const WRAPPERS: Record<string, { valueOpts: Set<string>; skipPositionals?: number }> = {
  command: { valueOpts: new Set() },
  builtin: { valueOpts: new Set() },
  exec: { valueOpts: new Set(["-a"]) },
  nohup: { valueOpts: new Set() },
  time: { valueOpts: new Set(["-f", "-o"]) },
  nice: { valueOpts: new Set(["-n"]) },
  caffeinate: { valueOpts: new Set(["-t", "-w"]) },
  stdbuf: { valueOpts: new Set(["-i", "-o", "-e"]) },
  sudo: { valueOpts: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"]) },
  doas: { valueOpts: new Set(["-u", "-C"]) },
  timeout: { valueOpts: new Set(["-s", "-k", "--signal", "--kill-after"]), skipPositionals: 1 },
  gtimeout: { valueOpts: new Set(["-s", "-k", "--signal", "--kill-after"]), skipPositionals: 1 },
  xargs: { valueOpts: new Set(["-n", "-I", "-L", "-P", "-s", "-d", "-E", "-a", "-J", "-R", "-S"]) },
};

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function names(words: Word[]): string[] {
  return words.map((w) => w.value);
}

/** True when an argument list mentions something this checker cares about. */
function mentionsGuardedVerb(words: Word[]): boolean {
  return words.some((w) => /^(push|commit|stack|--no-verify|--force.*|-f|-n)$/.test(w.value) || /hookspath/i.test(w.value));
}

export function analyzeScript(script: string, depth = 0): string | null {
  if (depth > 16) throw new Unverifiable("nesting too deep");
  for (const command of new Tokenizer(script, [], depth).run()) {
    const violation = analyzeCommand(command.words, depth, false, command.stdin);
    if (violation !== null) return violation;
  }
  return null;
}

const HUSKY_VAR = /^(HUSKY|HUSKY_SKIP_HOOKS)$/;
/** Builtins that assign/export their `NAME[=value]` arguments. */
const DECLARERS = new Set(["export", "declare", "typeset", "readonly", "local"]);

/**
 * A `NAME[=value]` the shell assigns or exports. `hasValue` false is a bare
 * `export NAME`. Denies HUSKY/HUSKY_SKIP_HOOKS outright, and GIT_CONFIG_*
 * whose value mentions hookspath.
 */
function checkEnvVar(w: Word, hasValue: boolean): string | null {
  const eq = w.value.indexOf("=");
  const name = hasValue ? w.value.slice(0, eq) : w.value;
  if (HUSKY_VAR.test(name)) return `${name} env (hook bypass)`;
  if (/^GIT_CONFIG_/.test(name)) {
    if (/hookspath/i.test(w.value)) return `${name} core.hooksPath (hook bypass)`;
    if (hasValue && w.expansion && /^GIT_CONFIG_(PARAMETERS|KEY_\d+)$/.test(name)) {
      throw new Unverifiable(`a ${name} value only known at run time`);
    }
  }
  return null;
}

function analyzeDeclare(args: Word[]): string | null {
  for (const a of args) {
    if (a.leadingExpansion) {
      if (/hookspath|HUSKY/i.test(a.value)) throw new Unverifiable("an exported name only known at run time");
      continue;
    }
    if (a.value.startsWith("-") || a.value.startsWith("+")) continue;
    const violation = checkEnvVar(a, ASSIGNMENT.test(a.value));
    if (violation !== null) return violation;
  }
  return null;
}

/** Commands that only print or search their arguments, never run them: exempt from the unknown-wrapper rule. */
const NEVER_EXECUTES_ARGS = new Set(["echo", "printf", "grep", "egrep", "fgrep", "rg", "cat", "ls", "wc", "head", "tail", "jq", "test", "["]);

/** `git` followed later by push/commit, or `gh` followed later by stack, anywhere in `words`. */
function hidesGuardedCall(words: Word[]): boolean {
  const at = (pred: (v: string) => boolean): number => words.findIndex((w) => pred(w.value));
  const git = at((v) => basename(v) === "git");
  if (git !== -1 && words.slice(git + 1).some((w) => w.value === "push" || w.value === "commit")) return true;
  const gh = at((v) => basename(v) === "gh");
  return gh !== -1 && words.slice(gh + 1).some((w) => w.value === "stack");
}

/** Fallback for argument text that does not tokenize as a script. */
const GUARDED_CALL_TEXT = /\bgit\b[\s\S]*\b(push|commit)\b|\bgh\b[\s\S]*\bstack\b/;
/** Characters that make one argument word worth re-tokenizing as a script of its own. */
const SCRIPT_CHARS = /[\s;&|'"`$\\()<>]/;

/**
 * One argument of an unknown wrapper, read as a shell script (`watch 'git
 * push -f'`, `ssh host '...'`, `npx "bash -c '...'"`): does it hide a git
 * push/commit or gh stack? Words of the tokenized script that could
 * themselves be scripts are checked the same way. Text that does not
 * tokenize falls back to a substring test.
 */
function argHidesGuardedCall(value: string, depth: number, level = 0): boolean {
  if (level > 8) return true; // fail closed: the cap on nested quoting is unreachable by any real argument
  let commands: SimpleCommand[];
  try {
    commands = new Tokenizer(value, [], depth).run();
  } catch {
    return GUARDED_CALL_TEXT.test(value);
  }
  for (const { words } of commands) {
    if (hidesGuardedCall(words)) return true;
    if (words[0]?.leadingExpansion && mentionsGuardedVerb(words.slice(1))) return true;
    for (const w of words) if (w.value !== value && SCRIPT_CHARS.test(w.value) && argHidesGuardedCall(w.value, depth + 1, level + 1)) return true;
  }
  return false;
}

/**
 * A2: builtins that set a variable without an assignment word: `printf -v
 * NAME`, `read [-a] NAME...`, `mapfile`/`readarray [NAME]` (and mapfile's
 * `-C callback`, which runs as shell code). Each name gets the same
 * HUSKY / GIT_CONFIG_* rules as an assignment, with its value unknown.
 */
const READ_VALUE_OPTS = "adinNptu";
const MAPFILE_VALUE_OPTS = "dnOsuCc";

function checkSetName(w: Word): string | null {
  if (w.leadingExpansion) throw new Unverifiable("a variable name only known at run time");
  const name = w.value.replace(/[[?].*$/s, ""); // `NAME[0]` sets NAME too; zsh `read NAME?prompt`
  if (HUSKY_VAR.test(name)) return `${name} env (hook bypass)`;
  if (/^GIT_CONFIG_(PARAMETERS|KEY_\d+)$/.test(name)) throw new Unverifiable(`a ${name} value only known at run time`);
  return null;
}

/**
 * Walks `-xVALUE` / `-x VALUE` style options (value-taking letters in
 * `valueOpts`), calling `onValue` for each option value. Returns the index of
 * the first operand.
 */
function walkShortOptions(args: Word[], valueOpts: string, onValue: (opt: string, value: Word) => string | null): { end: number; violation: string | null } {
  let j = 0;
  while (j < args.length) {
    const v = args[j].value;
    if (v === "--") return { end: j + 1, violation: null };
    if (!v.startsWith("-") || v === "-") break;
    let next = j + 1;
    for (let k = 1; k < v.length; k++) {
      if (!valueOpts.includes(v[k])) continue;
      const attached = v.slice(k + 1);
      // `-v$X`: the attached value starts with a run-time expansion.
      const runTime = args[j].expansion && (attached === "" || !args[j].leadingExpansion);
      const value = attached !== "" || args[j].expansion ? { ...args[j], value: attached, leadingExpansion: runTime } : args[j + 1];
      if (attached === "" && !args[j].expansion) next = j + 2;
      if (value !== undefined) {
        const violation = onValue(v[k], value);
        if (violation !== null) return { end: next, violation };
      }
      break;
    }
    j = next;
  }
  return { end: j, violation: null };
}

function analyzeVarSetter(name: string, args: Word[], depth: number): string | null {
  // `printf $OPT HUSKY 0`: an option word only known at run time could be `-v`.
  if (args.some((a) => a.leadingExpansion) && args.some((a) => /HUSKY|GIT_CONFIG_/.test(a.value))) {
    throw new Unverifiable(`a ${name} option only known at run time`);
  }
  if (name === "printf") {
    const { violation } = walkShortOptions(args, "v", (_opt, value) => checkSetName(value));
    return violation;
  }
  if (name === "read") {
    const { end, violation } = walkShortOptions(args, READ_VALUE_OPTS, (opt, value) => (opt === "a" ? checkSetName(value) : null));
    if (violation !== null) return violation;
    for (const a of args.slice(end)) {
      const v = checkSetName(a);
      if (v !== null) return v;
    }
    return null;
  }
  // mapfile / readarray
  const { end, violation } = walkShortOptions(args, MAPFILE_VALUE_OPTS, (opt, value) => {
    if (opt !== "C") return null;
    if (value.expansion) throw new Unverifiable("a mapfile callback only known at run time");
    const rule = analyzeScript(value.value, depth + 1);
    if (rule !== null) return rule;
    // The callback runs with arguments read from the input appended.
    if (argHidesGuardedCall(value.value, depth + 1)) throw new Unverifiable("git push/commit or gh stack in a mapfile callback");
    return null;
  });
  if (violation !== null) return violation;
  const array = args[end];
  return array === undefined ? null : checkSetName(array);
}

/** `find ... -exec|-execdir|-ok|-okdir <cmd...> ;|+`: each exec'd command, analyzed like xargs's. */
function analyzeFind(args: Word[], depth: number): string | null {
  for (let j = 0; j < args.length; j++) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[j].value)) continue;
    let k = j + 1;
    while (k < args.length && args[k].value !== ";" && !(args[k].value === "+" && args[k - 1]?.value === "{}")) k += 1;
    const violation = analyzeCommand(args.slice(j + 1, k), depth, true);
    if (violation !== null) return violation;
    j = k;
  }
  return null;
}

function analyzeCommand(words: Word[], depth: number, viaXargs = false, stdin: Stdin = INHERIT): string | null {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (RESERVED.has(w.value) && !w.quoted && !w.expansion) {
      i += 1;
      continue;
    }
    if (ASSIGNMENT.test(w.value) && !w.leadingExpansion) {
      const violation = checkEnvVar(w, true);
      if (violation !== null) return violation;
      i += 1;
      continue;
    }
    break;
  }
  if (i >= words.length) return null;

  const head = words[i];
  const rest = words.slice(i + 1);
  if (head.leadingExpansion) {
    if (mentionsGuardedVerb(rest)) throw new Unverifiable("the command name is only known at run time");
    return null;
  }
  const name = basename(head.value);

  if (name === "env") return analyzeEnv(rest, depth, stdin);
  if (DECLARERS.has(name)) return analyzeDeclare(rest);
  if (name === "direnv") {
    // `direnv exec <dir> <cmd...>` runs <cmd> (Ruling 31's spelling); every other subcommand is not a wrapper.
    if (rest[0]?.value !== "exec" || rest.length < 3) return null;
    return analyzeCommand(rest.slice(2), depth, viaXargs, stdin);
  }
  if (name === "find") return analyzeFind(rest, depth);
  if (name === "eval") return analyzeScript(names(rest).join(" "), depth + 1);
  if (SHELLS.has(name)) return analyzeShell(rest, depth, viaXargs, stdin);
  const wrapper = WRAPPERS[name];
  if (wrapper !== undefined) {
    let j = 0;
    while (j < rest.length && rest[j].value.startsWith("-") && rest[j].value !== "-") {
      if (rest[j].value === "--") {
        j += 1;
        break;
      }
      j += wrapper.valueOpts.has(rest[j].value) ? 2 : 1;
    }
    j += wrapper.skipPositionals ?? 0;
    // The command xargs runs does not read xargs's stdin.
    return analyzeCommand(rest.slice(j), depth, viaXargs || name === "xargs", name === "xargs" ? INHERIT : stdin);
  }
  if (name === "git") return analyzeGit(rest, depth, viaXargs);
  if (name === "gh") return analyzeGh(rest, depth, viaXargs);
  // Before the NEVER_EXECUTES_ARGS exemption: `printf -v` assigns.
  if (name === "printf" || name === "read" || name === "mapfile" || name === "readarray") {
    const violation = analyzeVarSetter(name, rest, depth);
    if (violation !== null) return violation;
  }
  if (NEVER_EXECUTES_ARGS.has(name)) return null;
  if (hidesGuardedCall(rest) || rest.some((a) => SCRIPT_CHARS.test(a.value) && argHidesGuardedCall(a.value, depth + 1))) {
    throw new Unverifiable(`git push/commit or gh stack inside ${name} (an unknown wrapper: run git/gh directly, or via direnv exec)`);
  }
  return null;
}

function analyzeEnv(args: Word[], depth: number, stdin: Stdin): string | null {
  let j = 0;
  const kept: Word[] = [];
  while (j < args.length) {
    const v = args[j].value;
    if (v === "--") {
      j += 1;
      break;
    }
    if (v === "-S" || v === "--split-string") return analyzeScript(names(args.slice(j + 1)).join(" "), depth + 1);
    if (v.startsWith("-S")) return analyzeScript([v.slice(2), ...names(args.slice(j + 1))].join(" "), depth + 1);
    if (v.startsWith("--split-string=")) return analyzeScript([v.slice(15), ...names(args.slice(j + 1))].join(" "), depth + 1);
    if (v === "-u" || v === "--unset" || v === "-C" || v === "--chdir") {
      j += 2;
      continue;
    }
    if (v.startsWith("-") && v !== "-") {
      j += 1;
      continue;
    }
    if (ASSIGNMENT.test(v)) {
      kept.push(args[j]);
      j += 1;
      continue;
    }
    break;
  }
  return analyzeCommand([...kept, ...args.slice(j)], depth, false, stdin);
}

function analyzeShell(args: Word[], depth: number, viaXargs: boolean, stdin: Stdin): string | null {
  let hasC = false;
  let readsStdin = false; // `-s`, or a `-` operand
  let infoOnly = false; // `--version` / `--help`: runs no script
  let j = 0;
  for (; j < args.length; j++) {
    const v = args[j].value;
    if (v === "-") {
      readsStdin = true;
      j += 1;
      break;
    }
    if (v === "--") {
      j += 1;
      break;
    }
    if (v === "-o" || v === "+o" || v === "-O" || v === "+O" || v === "--rcfile" || v === "--init-file") {
      j += 1;
      continue;
    }
    if (v.startsWith("--")) {
      if (v === "--version" || v === "--help") infoOnly = true;
      continue;
    }
    if ((v.startsWith("-") || v.startsWith("+")) && v.length > 1) {
      if (v.slice(1).includes("c")) hasC = true;
      if (v.startsWith("-") && v.slice(1).includes("s")) readsStdin = true;
      continue;
    }
    break;
  }
  if (!hasC) {
    // A script-file operand: not visible from here (documented residual).
    if (!readsStdin && args[j] !== undefined) return null;
    // xargs supplies the operand, or the shell's stdin, at run time.
    if (viaXargs) throw new Unverifiable("a shell run by xargs reads a script only known at run time");
    if (infoOnly && !readsStdin) return null;
    return analyzeStdinScript(stdin, depth);
  }
  const script = args[j];
  if (script === undefined) return null;
  if (script.expansion && /push|commit|stack|hookspath/i.test(script.value)) {
    throw new Unverifiable("a -c script built at run time");
  }
  return analyzeScript(script.value, depth + 1);
}

/**
 * A3: a shell with no `-c` and no script file reads its script from stdin.
 * A here-string, a heredoc, or a pipe from a literal `echo`/`printf` is
 * analyzed by content; anything else is unverifiable.
 */
function analyzeStdinScript(stdin: Stdin, depth: number): string | null {
  const unknown = (what: string): never => {
    throw new Unverifiable(`a shell reading its script from ${what} (only known at run time: use bash -c '<script>')`);
  };
  switch (stdin.kind) {
    case "herestring":
      if (stdin.word.expansion) unknown("a here-string built at run time");
      return analyzeScript(stdin.word.value + "\n", depth + 1);
    case "heredoc": {
      const { body, quoted } = stdin.doc;
      if (body === undefined) return unknown("an unterminated heredoc");
      if (quoted) return analyzeScript(body, depth + 1);
      // Unquoted: the shell expands `$...` / backticks before the script is parsed.
      if (/[$`]/.test(body.replace(/\\[\s\S]/g, ""))) unknown("a heredoc with expansions");
      return analyzeScript(body.replace(/\\([$`\\\n])/g, (_m, c: string) => (c === "\n" ? "" : c)), depth + 1);
    }
    case "pipe":
      if (stdin.from === null) return unknown("a pipe from a compound command");
      return analyzeScript(literalOutput(stdin.from) ?? unknown("a pipe from a command other than a literal echo/printf"), depth + 1);
    case "file":
      return unknown("a file redirect");
    case "inherit":
      return unknown("inherited stdin");
  }
}

/** What a literal `echo`/`printf` writes, or null when that is not knowable from the command text. */
function literalOutput(words: Word[]): string | null {
  let start = 0;
  while (start < words.length && RESERVED.has(words[start].value) && !words[start].quoted && !words[start].expansion) start += 1;
  const producer = words.slice(start);
  const head = producer[0];
  if (head === undefined || head.expansion || producer.some((w) => w.expansion)) return null;
  const name = basename(head.value);
  const args = producer.slice(1).map((w) => w.value);
  // Backslash escapes (`echo -e`, dash/zsh echo, printf) and printf `%` directives can spell anything.
  if (args.some((a) => a.includes("\\"))) return null;
  if (name === "echo") {
    let k = 0;
    while (k < args.length && /^-[neE]+$/.test(args[k])) {
      if (args[k].includes("e")) return null;
      k += 1;
    }
    return args.slice(k).join(" ") + "\n";
  }
  if (name === "printf") {
    const format = args[0] === "--" ? args[1] : args[0];
    if (format === undefined || format.startsWith("-") || format.includes("%")) return null;
    return format;
  }
  return null;
}

const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--exec-path", "--list-cmds"]);

function checkGitConfigPair(pair: Word, depth: number): string | null {
  if (pair.leadingExpansion) throw new Unverifiable("a git -c value only known at run time");
  if (/^core\.hookspath(=|$)/i.test(pair.value)) return "git -c core.hooksPath (hook bypass)";
  const alias = /^alias\.[^=]+=(.*)$/is.exec(pair.value);
  if (alias) return analyzeGitAlias(alias[1], depth);
  return null;
}

function analyzeGitAlias(value: string, depth: number): string | null {
  return value.startsWith("!") ? analyzeScript(value.slice(1), depth + 1) : analyzeScript(`git ${value}`, depth + 1);
}

function analyzeGit(args: Word[], depth: number, viaXargs: boolean): string | null {
  let i = 0;
  while (i < args.length && args[i].value.startsWith("-")) {
    const v = args[i].value;
    if (v === "-c" || v === "--config-env") {
      const pair = args[i + 1];
      if (pair !== undefined) {
        const violation = checkGitConfigPair(pair, depth);
        if (violation !== null) return violation;
      }
      i += 2;
      continue;
    }
    if (v.startsWith("--config-env=")) {
      const violation = checkGitConfigPair({ ...args[i], value: v.slice(13) }, depth);
      if (violation !== null) return violation;
      i += 1;
      continue;
    }
    i += GIT_GLOBAL_WITH_VALUE.has(v) ? 2 : 1;
  }
  const sub = args[i];
  if (sub === undefined) return null;
  if (sub.leadingExpansion) throw new Unverifiable("the git subcommand is only known at run time");
  const subArgs = args.slice(i + 1);

  if (viaXargs && (sub.value === "push" || sub.value === "commit")) {
    throw new Unverifiable(`git ${sub.value} via xargs (arguments only known at run time)`);
  }

  switch (sub.value) {
    case "push":
      return analyzePush(subArgs);
    case "commit":
      return analyzeCommit(subArgs);
    case "config":
      return analyzeGitConfig(subArgs, depth);
    default:
      for (const a of subArgs) {
        if (a.value === "--") break;
        if (isLongPrefixOf(a.value, "no-verify", 4)) return `git ${sub.value} --no-verify (hook bypass)`;
      }
      return null;
  }
}

/** `--name[=value]` where `name` is an abbreviation (>= minLen chars) of `full`, as git accepts. */
function isLongPrefixOf(arg: string, full: string, minLen: number): boolean {
  if (!arg.startsWith("--")) return false;
  const name = arg.slice(2).split("=")[0];
  return name.length >= minLen && full.startsWith(name);
}

const PUSH_BANNED_LONG: Array<[string, string]> = [
  ["force", "git push --force"],
  ["force-with-lease", "git push --force-with-lease"],
  ["force-if-includes", "git push --force-if-includes"],
  ["no-verify", "git push --no-verify (hook bypass)"],
  ["mirror", "git push --mirror (force-updates every ref)"],
];
const PUSH_LONG_WITH_VALUE = new Set(["repo", "receive-pack", "exec", "push-option"]);

function analyzePush(args: Word[]): string | null {
  let afterDashDash = false;
  for (let j = 0; j < args.length; j++) {
    const w = args[j];
    const v = w.value;
    if (!afterDashDash && v === "--") {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && v.startsWith("--")) {
      for (const [full, rule] of PUSH_BANNED_LONG) if (isLongPrefixOf(v, full, 2)) return rule;
      if (!v.includes("=") && PUSH_LONG_WITH_VALUE.has(v.slice(2))) j += 1;
      continue;
    }
    if (!afterDashDash && v.startsWith("-") && v.length > 1) {
      for (let k = 1; k < v.length; k++) {
        const ch = v[k];
        if (ch === "f") return "git push -f (force)";
        if (ch === "n") return "git push -n";
        if (ch === "o") {
          if (k === v.length - 1) j += 1;
          break;
        }
      }
      continue;
    }
    if (w.leadingExpansion) throw new Unverifiable("a git push argument only known at run time (could be a force flag or +refspec)");
    if (v.startsWith("+")) return "git push +refspec (force)";
  }
  return null;
}

const COMMIT_LONG_WITH_VALUE = new Set([
  "message", "file", "author", "date", "reuse-message", "reedit-message", "fixup", "squash",
  "template", "cleanup", "trailer", "pathspec-from-file",
]);
const COMMIT_SHORT_WITH_VALUE = "mFCct";
const COMMIT_SHORT_OPTIONAL_ATTACHED = "Su";

function analyzeCommit(args: Word[]): string | null {
  for (let j = 0; j < args.length; j++) {
    const w = args[j];
    const v = w.value;
    if (v === "--") break; // pathspecs follow
    if (v.startsWith("--")) {
      if (isLongPrefixOf(v, "no-verify", 4)) return "git commit --no-verify (hook bypass)";
      if (!v.includes("=") && COMMIT_LONG_WITH_VALUE.has(v.slice(2))) j += 1;
      continue;
    }
    if (v.startsWith("-") && v.length > 1) {
      for (let k = 1; k < v.length; k++) {
        const ch = v[k];
        if (ch === "n") return "git commit -n (hook bypass)";
        if (COMMIT_SHORT_WITH_VALUE.includes(ch)) {
          if (k === v.length - 1) j += 1;
          break;
        }
        if (COMMIT_SHORT_OPTIONAL_ATTACHED.includes(ch)) break;
      }
      continue;
    }
    if (w.leadingExpansion) throw new Unverifiable("a git commit argument only known at run time (could be -n)");
  }
  return null;
}

const CONFIG_READ_ONLY = new Set(["--get", "--get-all", "--get-regexp", "-l", "--list", "--unset", "--unset-all", "get", "list", "unset"]);

function analyzeGitConfig(args: Word[], depth: number): string | null {
  const readOnly = args.some((a) => CONFIG_READ_ONLY.has(a.value));
  for (let j = 0; j < args.length; j++) {
    const v = args[j].value;
    if (/^core\.hookspath$/i.test(v) && !readOnly) return "git config core.hooksPath (hook bypass)";
    if (/^alias\./i.test(v) && !readOnly) {
      const value = args[j + 1];
      if (value === undefined) return null;
      if (value.leadingExpansion) throw new Unverifiable("a git alias value only known at run time");
      return analyzeGitAlias(value.value, depth);
    }
  }
  return null;
}

const GH_STACK_BANNED = ["push", "sync", "submit"];

function analyzeGh(args: Word[], depth: number, viaXargs: boolean): string | null {
  let i = 0;
  while (i < args.length && args[i].value.startsWith("-")) i += args[i].value === "-R" || args[i].value === "--repo" ? 2 : 1;
  const sub = args[i];
  if (sub === undefined) return null;
  if (sub.leadingExpansion) throw new Unverifiable("the gh subcommand is only known at run time");
  const rest = args.slice(i + 1);
  const firstPositional = (words: Word[]): Word | undefined => words.find((w) => !w.value.startsWith("-"));

  if (sub.value === "stack") {
    const action = firstPositional(rest);
    if (action === undefined) return null;
    if (action.leadingExpansion) throw new Unverifiable("the gh stack subcommand is only known at run time");
    if (viaXargs) throw new Unverifiable("gh stack via xargs");
    const banned = GH_STACK_BANNED.find((b) => action.value.length > 0 && b.startsWith(action.value));
    return banned ? `gh stack ${banned}` : null;
  }
  if (sub.value === "repo" && firstPositional(rest)?.value === "sync") {
    if (rest.some((w) => w.value === "--force" || /^-[a-zA-Z]*f/.test(w.value))) return "gh repo sync --force";
    return null;
  }
  if (sub.value === "alias" && firstPositional(rest)?.value === "set") {
    const positionals = rest.filter((w) => !w.value.startsWith("-"));
    const expansion = positionals[2];
    if (expansion === undefined) return null;
    if (expansion.leadingExpansion) throw new Unverifiable("a gh alias expansion only known at run time");
    return expansion.value.startsWith("!")
      ? analyzeScript(expansion.value.slice(1), depth + 1)
      : analyzeGh(new Tokenizer(expansion.value, [], depth + 1).run()[0]?.words ?? [], depth + 1, false);
  }
  if (sub.value === "api") {
    const text = names(rest).join(" ");
    if (/git\/refs/.test(text) && /\bforce=true\b/.test(text)) return "gh api git/refs force=true (force update)";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

export type Decision = { code: 0 } | { code: 1; rule: string } | { code: 2; reason: string };

export function decide(stdin: string): Decision {
  if (typeof stdin !== "string") return { code: 2, reason: "no input" };
  if (stdin.trim().length === 0) return { code: 0 };
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return { code: 2, reason: "malformed JSON input" };
  }
  try {
    const record = payload as Record<string, unknown> | null;
    if (record?.tool_name !== "Bash") return { code: 0 };
    const command = (record?.tool_input as Record<string, unknown> | null | undefined)?.command;
    if (command === undefined || command === null || command === "") return { code: 0 };
    if (typeof command !== "string") return { code: 2, reason: "tool_input.command is not a string" };
    const rule = analyzeScript(command);
    return rule === null ? { code: 0 } : { code: 1, rule };
  } catch (err) {
    if (err instanceof Unverifiable) return { code: 2, reason: err.message };
    return { code: 2, reason: "internal error in the checker" };
  }
}

const PROCESS_EXIT_CODE = { 0: 0, 1: 3, 2: 2 } as const;

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const decision = decide(Buffer.concat(chunks).toString("utf8"));
  if (decision.code === 1) process.stdout.write(decision.rule);
  if (decision.code === 2) process.stdout.write(decision.reason);
  process.exit(PROCESS_EXIT_CODE[decision.code]);
}

/** Same symlink-safe "run directly" guard as the sibling checkers. */
function isRunAsScript(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isRunAsScript()) {
  process.on("uncaughtException", () => process.exit(2));
  process.on("unhandledRejection", () => process.exit(2));
  main().catch(() => process.exit(2));
}
