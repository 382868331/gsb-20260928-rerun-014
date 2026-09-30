import { vi } from 'vitest';

// jsdom 下统一的计时器环境（保持真实 setTimeout/clearTimeout）
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
