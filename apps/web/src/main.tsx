import '@xyflow/react/dist/style.css';
import './styles.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AppShell } from './app/AppShell.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
    },
  },
});

const root = document.querySelector('#root');
if (root === null) throw new Error('Root element was not found.');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  </StrictMode>,
);
