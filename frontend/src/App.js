import "@/App.css";
import { HashRouter, Routes, Route } from "react-router-dom";
import { Toaster } from "sonner";
import Dashboard from "@/pages/Dashboard";

function App() {
  return (
    <div className="App">
      <HashRouter>
        <Routes>
          <Route path="*" element={<Dashboard />} />
        </Routes>
      </HashRouter>
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          style: {
            background: "#111111",
            border: "1px solid #27272A",
            color: "#F4F4F5",
            borderRadius: 0,
            fontFamily: "IBM Plex Sans, sans-serif",
          },
        }}
      />
    </div>
  );
}

export default App;
