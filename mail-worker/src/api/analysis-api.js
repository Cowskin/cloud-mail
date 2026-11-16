import app from '../hono/hono';
import analysisService from '../service/analysis-service';
import result from '../model/result';
import {mailBufferStatus} from '../email/mail-buffer';

app.get('/analysis/echarts', async (c) => {
	const data = await analysisService.echarts(c, c.req.query());
	return c.json(result.ok(data));
})

app.get('/analysis/mailDelivery',async c=>c.json(result.ok(await mailBufferStatus(c.env))));
