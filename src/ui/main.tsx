import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// No StrictMode: in dev it double-mounts and double-runs effects, which would
// register the message subscription twice and duplicate scan starts.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
