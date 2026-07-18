import { Toaster as SonnerToaster } from 'sonner';
import { useTheme } from '@/theme/ThemeProvider';

export function Toaster() {
  const { resolved } = useTheme();
  return (
    <SonnerToaster
      theme={resolved}
      position="bottom-right"
      closeButton
      // richColors paints success green, errors red, warnings amber, info blue —
      // the mood is readable at a glance instead of every toast looking the same.
      richColors
      toastOptions={{
        classNames: {
          toast: '!rounded-lg !shadow-pop',
        },
      }}
    />
  );
}
