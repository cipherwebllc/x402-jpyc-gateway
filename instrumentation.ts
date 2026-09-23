export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { sellerConfig } = await import('./lib/sellerPins');
    sellerConfig();
  }
}
