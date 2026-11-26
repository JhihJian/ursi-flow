/**
 * 写操作的来源判定。
 *
 * 服务默认监听所有网卡，局域网里能浏览就够了；删会话、改偏好这两种会改动
 * 磁盘的请求必须来自本机，否则任何人打开页面都能删掉别人的历史。
 *
 * 只看 socket 的对端地址，不信任任何请求头：`X-Forwarded-For` 由客户端随便写。
 * 前面若挂了反向代理，代理本身在回环上，此时该由代理决定谁能访问。
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** IPv4 映射的 IPv6 形式（`::ffff:127.0.0.1`）也要认，双栈监听下常见。 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  return LOOPBACK.has(address)
}

export function createAccess() {
  return {
    /** 能改磁盘的来源：`request.socket.remoteAddress` 是回环地址。 */
    canWrite(request) {
      return isLoopbackAddress(request?.socket?.remoteAddress)
    },
  }
}
