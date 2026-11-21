import { createMcpClient } from '@ursi/mcp-web'
import { requestV2 } from '@/shared/http/client'

export const mcpClient = createMcpClient(requestV2)
