import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';
import DemoOne from '@/components/demo';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Dark by default: the LiquidButton glass effect only reads correctly on a dark surface. */}
    <div className="dark">
      <main className="min-h-screen bg-background text-foreground">
        <DemoOne />
      </main>
    </div>
  </StrictMode>,
);
