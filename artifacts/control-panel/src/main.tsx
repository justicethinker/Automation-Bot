import { createRoot } from "react-dom/client";
import { setApiKey } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

// Initialize API client with authentication key
const apiKey = import.meta.env.VITE_API_SECRET_KEY;
if (apiKey) {
  setApiKey(apiKey);
}

createRoot(document.getElementById("root")!).render(<App />);
