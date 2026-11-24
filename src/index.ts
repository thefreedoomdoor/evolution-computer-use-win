// The library entry: embed the plugin in any agent host that speaks JavaScript. Hosts that speak MCP run the CLI instead.
export { createComputerUse, type ComputerUse, type ComputerUseOptions } from './computer.ts';
export { INSTRUCTIONS } from './instructions.ts';
export { serveMcp, toContent, type McpTools } from './mcp/server.ts';
export { createJsonlSink, type MessageRecord, type MessageSink } from './procedures/messages.ts';
export { parseProcedure, ProcedureError, type Procedure } from './procedures/format.ts';
export { Faults } from './shared/faults.ts';
export type { Image, ImageMediaType } from './shared/image.ts';
export type { JsonSchema, ToolContext, ToolResult, ToolSpec } from './tool.ts';

// DSH plugin entry: package.json 的 main 指向本模块，宿主从这里读取 name / inject / apply。
export { apply, bridgeConfig, inject, name } from './plugin.ts';
export type { PluginConfig } from './plugin.ts';
