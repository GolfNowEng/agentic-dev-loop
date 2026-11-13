import { makeSbxAdapter } from "./adapter.ts";
import { realSbxRunner } from "./run.ts";

/** The registered sbx adapter, wired to the real sbx CLI. */
export const sbxAdapter = makeSbxAdapter({ run: realSbxRunner });
