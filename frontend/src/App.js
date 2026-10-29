import "@/App.css";
import { Toaster } from "sonner";
import Dashboard from "@/pages/Dashboard";
import { ThemeProvider, useTheme } from "@/hooks/use-theme";
import { ModuleProvider } from "@/hooks/use-modules";
import { AtlasProvider } from "@/hooks/use-atlases";

function AppShell() {
  const { theme } = useTheme();
  return (
    <div className="App">
      <Dashboard />
      <Toaster
        theme={theme}
        position="bottom-left"
        toastOptions={{
          style: {
            background: "hsl(var(--popover))",
            border: "1px solid hsl(var(--edge))",
            color: "hsl(var(--popover-foreground))",
            borderRadius: 8,
            boxShadow: "var(--elev-2)",
            fontFamily: "inherit",
          },
        }}
      />
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      {/* Fetches /api/modules once at startup; every capability-gated section
          reads it from context instead of probing asset URLs. */}
      <ModuleProvider>
        {/* Fetches /api/atlases once at startup. The atlas list is dynamic
            (install, import, uninstall, reorder), so every consumer reads it
            from context instead of importing a module-level constant. */}
        <AtlasProvider>
          <AppShell />
        </AtlasProvider>
      </ModuleProvider>
    </ThemeProvider>
  );
}

export default App;
