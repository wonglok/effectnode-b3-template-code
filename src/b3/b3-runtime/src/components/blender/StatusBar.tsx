"use client";

import { useState, useCallback, useRef, useEffect } from "react";
// import { Link } from "react-router-dom";
import type { ConnectionState } from "../types/blenderTypes";
import { useBlenderStore } from "../stores/blenderStore";
import { useSettingsStore } from "../stores/settingsStore";

const stateConfig: Record<ConnectionState, { color: string; label: string }> = {
  disconnected: { color: "bg-gray-500", label: "Disconnected" },
  connecting: { color: "bg-yellow-500", label: "Connecting..." },
  connected: { color: "bg-green-500", label: "Connected" },
  error: { color: "bg-red-500", label: "Error" },
};

export function StatusBar() {
  const connectionState = useBlenderStore((s) => s.connectionState);
  const objectCount = useBlenderStore((s) => s.sceneData.objects?.length ?? 0);
  const config = stateConfig[connectionState];

  const port = useSettingsStore((s) => s.port);
  const setPort = useSettingsStore((s) => s.setPort);

  const [editingPort, setEditingPort] = useState(false);
  const [draftPort, setDraftPort] = useState(String(port));
  const portInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraftPort(String(port));
  }, [port]);

  const handlePortEditStart = useCallback(() => {
    setDraftPort(String(port));
    setEditingPort(true);
  }, [port]);

  const handlePortCommit = useCallback(() => {
    const num = parseInt(draftPort, 10);
    if (num >= 1 && num <= 65535) {
      setPort(num);
    } else {
      setDraftPort(String(port));
    }
    setEditingPort(false);
  }, [draftPort, port, setPort]);

  const handlePortKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handlePortCommit();
      if (e.key === "Escape") {
        setDraftPort(String(port));
        setEditingPort(false);
      }
    },
    [handlePortCommit, port],
  );

  useEffect(() => {
    if (editingPort && portInputRef.current) {
      portInputRef.current.focus();
      portInputRef.current.select();
    }
  }, [editingPort]);

  return (
    <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-3 px-4 py-2 bg-black/60 backdrop-blur-sm text-white text-sm font-mono">
      {/* <Link
        to="/"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded
                   border border-white/15 bg-white/5
                   hover:bg-white/15 active:bg-white/20
                   transition-colors text-xs"
        title="Home"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
        <span className="hidden sm:inline">Home</span>
      </Link> */}

      <span className="text-white/20">|</span>
      <div className="flex items-center gap-2">
        <span
          className={`inline-block w-2.5 h-2.5 rounded-full ${config.color}`}
        />
        <span>{config.label}</span>
      </div>
      <span className="text-white/30">|</span>
      <span className="text-white/70 flex items-center gap-1">
        <span>ws://localhost:</span>
        {editingPort ? (
          <input
            ref={portInputRef}
            type="number"
            min={1}
            max={65535}
            value={draftPort}
            onChange={(e) => setDraftPort(e.target.value)}
            onBlur={handlePortCommit}
            onKeyDown={handlePortKeyDown}
            className="w-16 px-1 py-0.5 rounded border border-white/30 bg-white/10
                       text-white text-xs font-mono
                       focus:outline-none focus:border-white/50
                       [appearance:textfield]
                       [&::-webkit-outer-spin-button]:appearance-none
                       [&::-webkit-inner-spin-button]:appearance-none"
          />
        ) : (
          <button
            onClick={handlePortEditStart}
            className="hover:text-white transition-colors border-b border-dotted border-white/20
                       hover:border-white/50 cursor-text"
            title="Click to change port"
          >
            {port}
          </button>
        )}
      </span>
      {connectionState === "connected" && (
        <>
          <span className="text-white/30">|</span>
          <span className="text-white/70">
            Objects:{" "}
            <span className="text-white font-semibold">{objectCount}</span>
          </span>
        </>
      )}
      {connectionState === "disconnected" && (
        <span className="text-white/50 text-xs ml-auto">
          Reconnecting in 2s...
        </span>
      )}
    </div>
  );
}
