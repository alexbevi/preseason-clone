import type { Tool } from "../types";

export function ToolLogo({
  tool,
  size = 36,
}: {
  tool: { name: string; logoUrl: Tool["logoUrl"] };
  size?: number;
}) {
  if (!tool.logoUrl) {
    return (
      <div
        className="logo logo-placeholder"
        style={{ width: size, height: size }}
        aria-label={tool.name}
      >
        {tool.name.slice(0, 1)}
      </div>
    );
  }
  return (
    <img
      className="logo"
      style={{ width: size, height: size }}
      src={`https://www.preseason.ai${tool.logoUrl}`}
      alt={tool.name}
      loading="lazy"
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
      }}
    />
  );
}
