// OpenCode maps runtime packages such as @opentui/core to its own copies only for imports
// in this entry file, so the module is imported here and handed to the plugin.
import * as core from "@opentui/core"
import { createTuiPlugin } from "./src/tui/index.ts"

export default createTuiPlugin(core)
