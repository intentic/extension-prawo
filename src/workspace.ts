import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Where the agent-side CLI finds the workspace. The agent may stand in any directory under it (a repository, a
// conversation's worktree), so this walks up rather than trusting cwd: INTENTIC_WORKSPACE when the sandbox set it;
// else the nearest ancestor of `cwd` holding `.intentic`; else WORKSPACE_ROOT, else the sandbox's `/work`.
// The same rule as the monorepo's @intentic/connector-runtime `findWorkspaceRoot`, which is not published.
export const findWorkspaceRoot = (env: NodeJS.ProcessEnv, cwd: string, probe = ".intentic"): string => {
    const declared = env["INTENTIC_WORKSPACE"];
    if (declared !== undefined && declared !== "") {
        return declared;
    }
    for (let dir = cwd; ; dir = dirname(dir)) {
        if (existsSync(join(dir, probe))) {
            return dir;
        }
        if (dirname(dir) === dir) {
            return env["WORKSPACE_ROOT"] ?? "/work";
        }
    }
};
