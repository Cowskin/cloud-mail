import {describe, expect, it} from 'vitest';
import {generateBatchAddresses, validateAddressRule, randomAlphabet, addressExample, formatAddressRule} from '../../mail-vue/src/utils/batch-address.js';

const rule = (overrides = {}) => ({addressMode: 'sequence', prefix: 'user', separator: '', start: 1, padding: 3, count: 3, suffix: '@example.test', randomLength: 8, randomCharset: 'alphanumeric', excludeAmbiguous: true, ...overrides});

describe('batch address generation', () => {
    it('preserves legacy sequential addresses and numbers beyond padding', () => {
        expect(generateBatchAddresses(rule())).toEqual(['user001@example.test', 'user002@example.test', 'user003@example.test']);
        expect(generateBatchAddresses(rule({start: 999, count: 2}))[1]).toBe('user1000@example.test');
        expect(formatAddressRule({prefix: 'user', start: 1, padding: 3, count: 100, suffix: '@example.test'})).toBe('user001…@example.test，100 个');
    });

    it.each(['alphanumeric', 'letters', 'digits'])('generates 500 distinct lowercase %s addresses, with an optional prefix', charset => {
        for (const excludeAmbiguous of [true, false]) {
            const config = rule({addressMode: 'random', prefix: '', separator: '.', count: 500, randomCharset: charset, excludeAmbiguous});
            const addresses = generateBatchAddresses(config);
            expect(new Set(addresses).size).toBe(500);
            const allowed = new RegExp(`^[${randomAlphabet(config)}]{8}@example\\.test$`);
            expect(addresses.every(email => allowed.test(email))).toBe(true);
        }
    });

    it('combines sequential numbers and random text without consuming randomness for the example', () => {
        const config = rule({addressMode: 'sequenceRandom', prefix: 'Team', separator: '_', randomLength: 4});
        const addresses = generateBatchAddresses(config, bytes => bytes.fill(0));
        expect(addresses).toEqual(['team_001_aaaa@example.test', 'team_002_aaaa@example.test', 'team_003_aaaa@example.test']);
        expect(addressExample(config)).toMatch(/^team_001_[a-z2-9]{4}@example\.test$/);
        expect(formatAddressRule(config)).toContain('Team_001_[4位随机字母数字]');
    });

    it('retries batch collisions and fails within a bound when randomness cannot supply distinct addresses', () => {
        let calls = 0;
        const addresses = generateBatchAddresses(rule({addressMode: 'random', count: 2}), bytes => bytes.fill(calls++ < 2 ? 0 : 1));
        expect(new Set(addresses).size).toBe(2);
        expect(calls).toBe(3);
        expect(() => generateBatchAddresses(rule({addressMode: 'random', count: 2}), bytes => bytes.fill(0))).toThrow('重复过多');
    });

    it('rejects biased tail bytes instead of applying modulo to them', () => {
        const addresses = generateBatchAddresses(rule({addressMode: 'random', randomCharset: 'digits', excludeAmbiguous: false, count: 1, randomLength: 4}), bytes => { bytes.fill(255); bytes.set([250, 251, 0, 1, 2, 3]); });
        expect(addresses).toEqual(['user0123@example.test']);
        expect(() => generateBatchAddresses(rule({addressMode: 'random'}), bytes => bytes.fill(255))).toThrow('生成失败');
    });

    it.each([
        {count: null}, {count: 0}, {count: 501}, {count: 1.5}, {start: null}, {padding: null},
        {suffix: undefined}, {prefix: 'a b'}, {prefix: '.user'}, {prefix: 'user.', separator: '.'},
        {addressMode: 'random', randomLength: null}, {addressMode: 'random', randomLength: 3},
        {addressMode: 'random', randomCharset: 'unknown'},
        {addressMode: 'sequenceRandom', prefix: 'x'.repeat(30), randomLength: 32, padding: 8},
    ])('rejects incomplete or invalid rules: %j', overrides => {
        expect(validateAddressRule(rule(overrides))).not.toBe('');
        expect(() => generateBatchAddresses(rule(overrides))).toThrow();
        expect(addressExample(rule(overrides))).toBe('');
    });

    it('allows an empty prefix only in random modes and validates the full local part', () => {
        expect(validateAddressRule(rule({prefix: ''}))).not.toBe('');
        expect(validateAddressRule(rule({prefix: '', addressMode: 'random'}))).toBe('');
        expect(validateAddressRule(rule({prefix: '', addressMode: 'sequenceRandom'}))).toBe('');
        expect(validateAddressRule(rule({prefix: 'x'.repeat(32), addressMode: 'random', randomLength: 32}))).toBe('');
        expect(validateAddressRule(rule({prefix: 'x'.repeat(33), addressMode: 'random', randomLength: 32}))).toContain('64');
    });
});
