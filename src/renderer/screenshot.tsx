import { createRoot } from "react-dom/client";
import { ScreenshotOverlay } from "./screenshot/ScreenshotOverlay";
import "./screenshot/ScreenshotOverlay.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Screenshot overlay root not found");

createRoot(rootElement).render(<ScreenshotOverlay />);
