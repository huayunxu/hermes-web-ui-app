import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.hermes.agent',
  appName: 'Hermes',
  webDir: 'dist/client',
  server: {
    // 客户端连接地址留空，登录页让用户输入
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
};
export default config;