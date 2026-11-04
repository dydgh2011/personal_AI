import { IsString, Matches, MaxLength } from 'class-validator';

export const MAX_REPORT_LENGTH = 500_000;

export class CompleteTaskDto {
  @IsString()
  @MaxLength(MAX_REPORT_LENGTH)
  result: string;
}

export class FailTaskDto {
  @IsString()
  @Matches(/\S/, { message: 'error must not be blank' })
  @MaxLength(MAX_REPORT_LENGTH)
  error: string;
}
