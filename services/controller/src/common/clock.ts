import { Injectable } from '@nestjs/common';

/** Source of the current time. Replaced in tests to control leases and timestamps. */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}
