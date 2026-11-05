import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ControlPanelApp from "./components/ControlPanelApp";
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get("panel") === "control" ? (
      <ControlPanelApp />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
