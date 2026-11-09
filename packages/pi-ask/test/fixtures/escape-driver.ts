import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function escapeDriver(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const custom = ctx.ui.custom.bind(ctx.ui);
    ctx.ui.custom = (factory, options) =>
      custom(async (...args) => {
        const component = await factory(...args);
        setImmediate(() => component.handleInput?.("\u001b"));
        return component;
      }, options);
  });
}
