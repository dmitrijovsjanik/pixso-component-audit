import { useEffect } from "react";
import type { IncomingMsg, OutgoingMsg } from "./types";

// UI -> sandbox. Exact protocol from the original ui.html: parent.postMessage
// with a { pluginMessage } envelope.
export function post(msg: OutgoingMsg) {
  parent.postMessage({ pluginMessage: msg }, "*");
}

// Subscribe to sandbox -> UI messages. Sandbox posts land in
// event.data.pluginMessage.
export function useSandboxMessages(handler: (msg: IncomingMsg) => void) {
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data?.pluginMessage as IncomingMsg | undefined;
      if (!msg) return;
      handler(msg);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handler]);
}
