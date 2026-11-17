import { createApp } from 'vue'
import { createPinia } from 'pinia'
import AppShell from '@/app/AppShell.vue'
import { createAppRouter } from '@/app/router'
import '@/app/styles.css'

createApp(AppShell).use(createPinia()).use(createAppRouter()).mount('#app')
