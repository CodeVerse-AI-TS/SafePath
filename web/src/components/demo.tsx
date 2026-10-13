import { LiquidButton, MetalButton } from "@/components/ui/liquid-glass-button"
import { Navigation, ShieldCheck } from "lucide-react"

/*
 * Demo for the vendored LiquidButton / MetalButton.
 *
 * Two deliberate deviations from the upstream snippet:
 *  - The upstream container was a fixed `h-[200px] w-[800px]`, which overflows
 *    a 320 px viewport. It is responsive here; the component itself is unchanged.
 *  - A second LiquidButton is rendered so the per-instance glass filter id can
 *    be seen working (two buttons, two distinct filter definitions).
 */
export default function DemoOne() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-10 px-4 py-10">
      <div className="relative h-[200px] w-full">
        <LiquidButton className="absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
          Liquid Glass
        </LiquidButton>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-6">
        <LiquidButton size="lg">
          <Navigation className="size-4" aria-hidden="true" />
          Safe route
        </LiquidButton>
        <LiquidButton size="lg" variant="secondary">
          <ShieldCheck className="size-4" aria-hidden="true" />
          Report
        </LiquidButton>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-6">
        <MetalButton variant="default">Default</MetalButton>
        <MetalButton variant="primary">Primary</MetalButton>
        <MetalButton variant="success">Success</MetalButton>
        <MetalButton variant="error">Error</MetalButton>
        <MetalButton variant="gold">Gold</MetalButton>
        <MetalButton variant="bronze">Bronze</MetalButton>
      </div>
    </div>
  )
}
