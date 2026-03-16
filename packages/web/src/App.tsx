import { Routes, Route, Navigate } from "react-router-dom";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexReactClient } from "convex/react";
import { useAuth } from "@clerk/clerk-react";
import SnapshotViewer from "./pages/SnapshotViewer";
import Library from "./pages/Library";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);

export default function App() {
  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      <Routes>
        <Route path="/snapshot/:shareToken" element={<SnapshotViewer />} />
        <Route path="/library" element={<Library />} />
        <Route path="/" element={<Navigate to="/library" replace />} />
        <Route path="*" element={<Navigate to="/library" replace />} />
      </Routes>
    </ConvexProviderWithClerk>
  );
}
