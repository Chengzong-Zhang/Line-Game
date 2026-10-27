import { createWxPlatform } from './platform.js';
import { createApp } from './app.js';

createApp(createWxPlatform(wx), __APP_CONFIG__);
