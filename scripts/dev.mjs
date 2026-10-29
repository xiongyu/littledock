import { launch } from '../backend/src/desktop/launcher.ts'
await launch('dev', { console: process.platform !== 'win32' || process.env.WEBNAV_NO_TRAY === '1' })
