// 协议握手：protocol.version 表示 major；应用版本与 Pi 版本只是实现元数据，不参与兼容判断。
export const PROTOCOL_VERSION = 1;

export interface ServiceInfo {
  serviceId: string;
  instanceId: string;
  protocol: { version: number; minClient: number };
  app: { version: string };
  capabilities: string[];
}

export interface ProtocolNegotiation {
  ok: boolean;
  reason?: string;
}

export function negotiateProtocol(
  info: Pick<ServiceInfo, "protocol">,
  clientProtocol = PROTOCOL_VERSION,
): ProtocolNegotiation {
  const { version, minClient } = info.protocol;
  if (!Number.isInteger(version) || version < 1 || !Number.isInteger(minClient) || minClient < 1) {
    return { ok: false, reason: "Service advertised an invalid protocol version" };
  }
  if (version !== clientProtocol) {
    return { ok: false, reason: `Unsupported protocol major: service ${version}, client ${clientProtocol}` };
  }
  if (minClient > clientProtocol) {
    return { ok: false, reason: `Service requires client protocol ${minClient}+` };
  }
  return { ok: true };
}
