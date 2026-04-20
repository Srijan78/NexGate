import { 
  calculateZoneDensity, 
  calculateQueueLength, 
  calculateConcessionData 
} from '../index.js';

describe('NexGate Simulator Logic', () => {
  
  describe('calculateZoneDensity', () => {
    const mockZone = { id: 'test_zone', name: 'Test Zone', base_load: 50 };
    
    test('should return density within 0-100 bounds', () => {
      for (let i = 0; i < 100; i++) {
        const density = calculateZoneDensity(mockZone, i, null);
        expect(density).toBeGreaterThanOrEqual(0);
        expect(density).toBeLessThanOrEqual(100);
      }
    });

    test('should apply surge multiplier when event is active', () => {
      const activeEvent = {
        id: 'kickoff',
        label: 'Kickoff',
        time_offset_min: 0,
        surge_multiplier: 1.5,
        surge_zones: ['test_zone']
      };
      
      // Test at peak surge (minute 5)
      const baseDensity = calculateZoneDensity(mockZone, 5, null);
      const surgedDensity = calculateZoneDensity(mockZone, 5, activeEvent);
      
      // Surged should be significantly higher than base
      expect(surgedDensity).toBeGreaterThan(baseDensity);
    });
  });

  describe('calculateQueueLength', () => {
    test('should scale queue with density', () => {
      const lowQueue = calculateQueueLength(20, 1000);
      const highQueue = calculateQueueLength(90, 1000);
      
      expect(highQueue).toBeGreaterThan(lowQueue);
    });

    test('should always return an integer', () => {
      const queue = calculateQueueLength(55.5, 500);
      expect(Number.isInteger(queue)).toBe(true);
    });
  });

  describe('calculateConcessionData', () => {
    const mockStand = { id: 'stand_a', base_load: 30, lanes_total: 10 };

    test('should spike load during halftime', () => {
      const normalData = calculateConcessionData(mockStand, 10, null);
      const halftimeEvent = { label: 'Halftime' };
      const halftimeData = calculateConcessionData(mockStand, 45, halftimeEvent);
      
      expect(halftimeData.load_percent).toBeGreaterThan(normalData.load_percent);
      expect(halftimeData.predicted_surge).toBe(true);
    });

    test('should never open more lanes than total available', () => {
      const data = calculateConcessionData(mockStand, 10, { label: 'Halftime' });
      expect(data.lanes_open).toBeLessThanOrEqual(mockStand.lanes_total);
    });
  });
});
