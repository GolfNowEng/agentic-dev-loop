// Fire-and-forget desktop notification (macOS only): a parked ticket needs a
// human. osascript runs through execFile (no shell); the AppleScript string
// literals escape `\` and `"`, and both strings are redacted first. Never
// throws; does nothing on other platforms.

import { execFile } from "node:child_process";
import { redactSensitive } from "./redact.ts";

export type ExecFileFn = (cmd: string, args: string[], cb?: (err: Error | null) => void) => void;

const realExec: ExecFileFn = (cmd, args, cb) => {
  execFile(cmd, args, (err) => cb?.(err));
};

const appleString = (s: string): string => `"${redactSensitive(s).replace(/[\\"]/g, (c) => `\\${c}`)}"`;

export function notify(title: string, body: string, exec: ExecFileFn = realExec, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "darwin") return;
  const script = `display notification ${appleString(body)} with title ${appleString(title)}`;
  try {
    exec("osascript", ["-e", script], () => {
      /* best effort: a failed notification is not worth reporting */
    });
  } catch {
    /* best effort */
  }
}
