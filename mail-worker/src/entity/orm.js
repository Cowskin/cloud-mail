import { drizzle } from 'drizzle-orm/d1';

export default function orm(c) {
	// SQL parameter logging can include original bodies and protection material.
	return drizzle(c.env.db,{logger: false})
}
