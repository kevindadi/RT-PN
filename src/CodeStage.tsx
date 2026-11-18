import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  type DecorationSet,
} from "@codemirror/view";

const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "transparent",
      color: "#b9cde3",
      fontSize: "12.5px",
    },
    ".cm-scroller": {
      fontFamily:
        '"Cascadia Mono", "JetBrains Mono", "SFMono-Regular", Consolas, monospace',
      lineHeight: "1.62",
      overflow: "auto",
    },
    ".cm-content": {
      padding: "14px 22px 28px 8px",
      caretColor: "transparent",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "#34465f",
      border: "none",
      paddingRight: "4px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 10px 0 14px",
      minWidth: "44px",
    },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#52627a" },
    ".cm-selectionBackground, ::selection": {
      backgroundColor: "#0e7490 !important",
    },
    ".cm-cursor": { display: "none" },
    ".cm-searchMatch": {
      backgroundColor: "#155e75",
      outline: "1px solid #22d3ee",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "#0e7490",
    },
    ".cm-panels": {
      backgroundColor: "#0b1422",
      color: "#dce9f8",
      borderTop: "1px solid #1e2f49",
    },
    ".cm-panels input": {
      backgroundColor: "#091321",
      color: "#dce9f8",
      border: "1px solid #1e2f49",
      borderRadius: "4px",
      padding: "3px 6px",
    },
    ".cm-panels button": {
      backgroundColor: "#111b2e",
      color: "#dce9f8",
      border: "1px solid #1e2f49",
      borderRadius: "4px",
    },
    ".cm-foldGutter": { color: "#34465f" },
    ".cm-heading": { color: "#7dd3fc", fontWeight: "600" },
    ".cm-danger": { color: "#fb7185" },
    ".cm-good": { color: "#34d399" },
    ".cm-violet": { color: "#c4b5fd" },
    ".cm-note": { color: "#fbbf24" },
  },
  { dark: true },
);

function lineClass(text: string): string | null {
  if (text.startsWith("ANALYSIS FAILED") || text.includes("[unknown]")) {
    return "cm-danger";
  }
  if (text.startsWith("  NOTE")) {
    return "cm-note";
  }
  if (
    text.includes("[exact]") ||
    text.includes("[measured]") ||
    text.includes("[certified]")
  ) {
    return "cm-good";
  }
  if (text.includes("[model]")) {
    return "cm-violet";
  }
  if (
    /^[A-Z][A-Z0-9 |/_-]{2,}/.test(text) &&
    !text.startsWith("  ")
  ) {
    return "cm-heading";
  }
  return null;
}

const stageLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.build(update.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      for (const range of view.visibleRanges) {
        let position = range.from;
        while (position <= range.to) {
          const line = view.state.doc.lineAt(position);
          const className = lineClass(line.text);
          if (className) {
            builder.add(
              line.from,
              line.from,
              Decoration.line({ class: className }),
            );
          }
          position = line.to + 1;
        }
      }
      return builder.finish();
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

interface CodeStageProps {
  doc: string;
  stageKey: string;
}

export function CodeStage({ doc, stageKey }: CodeStageProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const stageRef = useRef(stageKey);

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc,
      extensions: [
        basicSetup,
        stageLines,
        editorTheme,
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Editor is created once; document updates are dispatched below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== doc) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: doc },
      });
    }
    if (stageRef.current !== stageKey) {
      stageRef.current = stageKey;
      view.scrollDOM.scrollTop = 0;
      view.scrollDOM.scrollLeft = 0;
    }
  }, [doc, stageKey]);

  return <div className="code-stage" ref={hostRef} />;
}
