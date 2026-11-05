import { accessSync, constants, lstatSync } from "node:fs";

export interface HostGeminiSource {
  readonly kind: "worker_host";
  ready(): boolean;
}

/**
 * Opens only the metadata boundary for a dedicated Gemini host login. It deliberately
 * never discovers or reads credential files below `home`; a later harness owns that work.
 */
export function openHostGeminiSource(home: string, cli: string): HostGeminiSource {
  return {
    kind: "worker_host",
    ready(): boolean {
      try {
        const homeStat = lstatSync(home);
        if (
          homeStat.isSymbolicLink()
          || !homeStat.isDirectory()
          || (homeStat.mode & 0o777) !== 0o700
          || (typeof process.getuid === "function" && homeStat.uid !== process.getuid())
        ) {
          return false;
        }
        const cliStat = lstatSync(cli);
        const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
        if (
          cliStat.isSymbolicLink()
          || !cliStat.isFile()
          || (cliStat.mode & 0o111) === 0
          || (cliStat.mode & 0o022) !== 0
          || uid === undefined
          || (cliStat.uid !== uid && cliStat.uid !== 0)
        ) {
          return false;
        }
        accessSync(cli, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}
