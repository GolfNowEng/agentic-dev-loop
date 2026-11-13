// Command runner for the sbx CLI. execFile with an args array, never a shell.
// The execFile implementation is injected so tests never run the real binary.

import { execFile } from "node:child_process";

export const SBX_CALL_TIMEOUT_MS = 30_000;

export type SbxResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
export type SbxRunner = (args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<SbxResult>;

type ExecErr = (Error & { code?: number | string | null; killed?: boolean; signal?: string | null }) | null;
export type SbxExecFile = (
  cmd: string,
  args: string[],
  opts: { timeout: number; env?: NodeJS.ProcessEnv; shell?: boolean; maxBuffer?: number },
  cb: (err: ExecErr, stdout: string, stderr: string) => void,
) => void;

const nodeExecFile: SbxExecFile = (cmd, args, opts, cb) => {
  execFile(cmd, args, { ...opts, encoding: "utf8" }, (err, stdout, stderr) => cb(err as ExecErr, String(stdout), String(stderr)));
};

export function makeSbxRunner(execFileImpl: SbxExecFile): SbxRunner {
  return (args, opts = {}) =>
    new Promise((resolve) => {
      const timeout = opts.timeoutMs ?? SBX_CALL_TIMEOUT_MS;
      execFileImpl("sbx", args, { timeout, env: opts.env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr, timedOut: false });
        const timedOut = err.killed === true;
        resolve({ code: typeof err.code === "number" ? err.code : null, stdout, stderr, timedOut });
      });
    });
}

export const realSbxRunner: SbxRunner = makeSbxRunner(nodeExecFile);
