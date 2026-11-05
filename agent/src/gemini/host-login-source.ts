import fs from "node:fs";

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
        const homeStat = fs.lstatSync(home);
        if (
          homeStat.isSymbolicLink()
          || !homeStat.isDirectory()
          || (homeStat.mode & 0o777) !== 0o700
          || (typeof process.getuid === "function" && homeStat.uid !== process.getuid())
        ) {
          return false;
        }
        const cliLstat = fs.lstatSync(cli);
        const cliStat = fs.statSync(cli);
        if (cliLstat.isSymbolicLink() || !cliLstat.isFile() || !cliStat.isFile() || (cliStat.mode & 0o111) === 0) {
          return false;
        }
        fs.accessSync(cli, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}
