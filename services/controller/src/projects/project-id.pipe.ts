import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { PROJECT_ID_PATTERN } from '../config/app-config.js';

/** Rejects anything that is not a project id before it reaches the registry. */
@Injectable()
export class ProjectIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
      throw new BadRequestException('Invalid project id');
    }
    return value;
  }
}
