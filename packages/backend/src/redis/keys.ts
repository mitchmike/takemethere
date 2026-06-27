export const keys = {
  vehicle: (tripId: string) => `vehicle:${tripId}`,
  vehiclesByLine: (lineId: string) => `vehicles:line:${lineId}`,
};

export const channels = {
  vehicles: 'gtfs-rt:vehicles',
};
