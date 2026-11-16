import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		include: ['test/**/*.spec.js'],
		poolOptions: {
			workers: {
				main: './src/index.js',
				miniflare: {
					compatibilityDate: '2025-06-04',
					d1Databases: ['db'],
					kvNamespaces: ['kv'],
					r2Buckets: ['MAIL_SPOOL'],
					bindings: { admin: 'admin@example.test', domain: ['example.test'], jwt_secret: 'LOCAL-TEST-ONLY-NOT-A-PRODUCTION-SECRET' },
				},
			},
		},
	},
});
