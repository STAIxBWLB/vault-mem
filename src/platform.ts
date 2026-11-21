import * as platform from "@staix/agent-mem/platform";
import { amemVersion, checkHostApi } from "./amem/host-api.ts";

checkHostApi(platform, amemVersion());
export const { realPath, canonicalPath, isDenied, DENY_SEGMENTS, memoryGitArgv, memoryGitEnv } = platform;
export const agentMemInfo = { version: amemVersion(), hostApi: platform.HOST_API_VERSION, hostApiMin: platform.HOST_API_MIN };
