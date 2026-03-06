/** @type {import('jest').Config} */
module.exports = {
  displayName: 'dss-core',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/../../tsconfig.json' }],
  },
  testMatch: ['<rootDir>/src/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
  restoreMocks: true,
};
