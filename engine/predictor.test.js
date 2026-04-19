import { predictZone, recordReading } from './predictor.js';

describe('NexGate Predictor - Fallback Logic (No Gemini)', () => {
  const mockZone = {
    id: 'test_zone',
    name: 'Test Zone North',
    capacity: 1000,
    base_load: 30,
  };

  test('Gracefully handles zero readings', async () => {
    // Attempt prediction with no data
    const result = await predictZone(mockZone, 'Test event');
    expect(result).toBeNull();
  });

  test('Calculates simple moving average correctly on stable data', async () => {
    // Populate readings: 50% flat
    for (let i = 0; i < 5; i++) {
      recordReading('test_zone_stable', {
        density: 50,
        queue_length: 10,
        timestamp: 'now',
      });
    }

    mockZone.id = 'test_zone_stable';
    const result = await predictZone(mockZone, 'Test event');

    expect(result.source).toBe('fallback');
    expect(result.predicted_density_10m).toBeCloseTo(50, 0);
    expect(result.risk_level).toBe('low');
  });

  test('Raises critical risk on surging density trend', async () => {
    // Populate readings: 70, 75, 80, 85 (rapid rise)
    const risingData = [70, 75, 80, 85];
    risingData.forEach((d) => {
      recordReading('test_zone_surge', {
        density: d,
        queue_length: 50,
        timestamp: 'now',
      });
    });

    mockZone.id = 'test_zone_surge';
    const result = await predictZone(mockZone, 'Test event');

    expect(result.source).toBe('fallback');
    expect(result.predicted_density_10m).toBeGreaterThan(85); // Should trend upward
    expect(result.risk_level).toMatch(/high|critical/); // Trend pushes it into high/critical
  });

  test('Maintains capacity caps (max 100%)', async () => {
    const extremeData = [95, 96, 98, 99];
    extremeData.forEach((d) => {
      recordReading('test_zone_max', {
        density: d,
        queue_length: 100,
        timestamp: 'now',
      });
    });

    mockZone.id = 'test_zone_max';
    const result = await predictZone(mockZone, 'Test event');

    expect(result.predicted_density_10m).toBeLessThanOrEqual(100);
    expect(result.risk_level).toBe('critical');
  });
});
