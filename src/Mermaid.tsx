import { useEffect, useRef, useState } from "react";

let mermaidPromise: ReturnType<typeof loadMermaidImpl> | null = null;

async function loadMermaidImpl() {
  const module = await import("mermaid");
  const mermaid = module.default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    fontFamily:
      '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif',
    themeVariables: {
      darkMode: true,
      background: "#0b1422",
      primaryColor: "#12314f",
      primaryTextColor: "#e6f1ff",
      primaryBorderColor: "#4fa3ff",
      lineColor: "#5d84ab",
      secondaryColor: "#0f2138",
      secondaryTextColor: "#cfe6ff",
      secondaryBorderColor: "#2b537d",
      tertiaryColor: "#0a1526",
      tertiaryTextColor: "#b9d3ec",
      tertiaryBorderColor: "#244a73",
      textColor: "#dce8f5",
      edgeLabelBackground: "#0b1422",
      clusterBkg: "#08111f",
      clusterBorder: "#17304d",
      noteBkgColor: "#12263f",
      noteTextColor: "#cfe6ff",
      noteBorderColor: "#2b537d",
      fontSize: "13px",
    },
    flowchart: {
      htmlLabels: true,
      curve: "basis",
      padding: 14,
      nodeSpacing: 42,
      rankSpacing: 52,
      useMaxWidth: true,
    },
  });
  return mermaid;
}

function loadMermaid() {
  mermaidPromise ??= loadMermaidImpl();
  return mermaidPromise;
}

/**
 * Renders a Mermaid diagram (`flowchart`, `stateDiagram-v2`, ...). The library
 * is loaded lazily so the workbench bundle stays small; failures fall back to
 * the raw Mermaid source instead of breaking the stage.
 */
export function Mermaid({ chart, className }: { chart: string; className?: string }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const idRef = useRef(`mmd-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let alive = true;
    setSvg("");
    setError("");
    loadMermaid()
      .then((mermaid) =>
        mermaid.render(`${idRef.current}-${Date.now().toString(36)}`, chart.trim()),
      )
      .then(({ svg: markup }) => {
        if (alive) setSvg(markup);
      })
      .catch((reason: unknown) => {
        if (alive) setError(String(reason));
      });
    return () => {
      alive = false;
    };
  }, [chart]);

  return (
    <div className={`mmd ${className ?? ""}`}>
      {error ? (
        <pre className="mmd-fallback">{chart.trim()}</pre>
      ) : svg ? (
        <div className="mmd-canvas" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="mmd-loading">rendering diagram...</div>
      )}
    </div>
  );
}
