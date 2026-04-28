import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defaultLogger as logger, ConsoleLogger, NullLogger } from '../../../src/utils/logger.js';

describe('logger', () => {
    let mockInfo: any;
    let mockDebug: any;
    let mockWarn: any;
    let mockError: any;

    beforeEach(() => {
        mockInfo = vi.spyOn(console, 'info').mockImplementation(() => { });
        mockDebug = vi.spyOn(console, 'debug').mockImplementation(() => { });
        mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        mockError = vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('ConsoleLogger logs info securely', () => {
        const data = { secret: 'hidden123' };
        logger.info('Test Info', data);
        expect(mockInfo).toHaveBeenCalled();
        const callArgs = mockInfo.mock.calls[0][0];
        const parsed = JSON.parse(callArgs);
        expect(parsed.msg).toBe('Test Info');
        expect(parsed.prefix).toBe('[wa-job-queue]');
        expect(parsed.data[0].secret).toBe('hidden123');
    });

    it('ConsoleLogger logs default debug', () => {
        logger.debug('Testing debug', { x: 1 });
        expect(mockDebug).toHaveBeenCalled();
    });

    it('ConsoleLogger logs warnings and errors appropriate', () => {
        logger.warn('Warning test');
        logger.error('Error test', new Error('test boom'));
        expect(mockWarn).toHaveBeenCalled();
        expect(mockError).toHaveBeenCalled();
    });

    it('NullLogger discards output', () => {
        const nl = new NullLogger();
        nl.info('Discard');
        nl.debug('Discard');
        nl.warn('Discard');
        nl.error('Discard');
        expect(mockInfo).not.toHaveBeenCalled();
        expect(mockError).not.toHaveBeenCalled();
    });
});
