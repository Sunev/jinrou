import * as React from 'react';
import styled from 'styled-components';
import { observer } from 'mobx-react';
import { Log, LogVisibility } from '../defs';

import { OneLog } from './log';

export interface IPropLogs {
  /**
   * All logs.
   */
  logs: Log[];
  /**
   * Visibility of logs.
   */
  visibility: LogVisibility;
  /**
   * Icons of users.
   */
  icons: Record<string, string | undefined>;
  /**
   * Current rule setting.
   */
  rule: Record<string, string>;
}
/**
 * Shows all logs.
 */
@observer
export class Logs extends React.PureComponent<IPropLogs, {}> {
  public render() {
    const { logs, rule, icons } = this.props;
    // MobX observable array returns a reversed copy of original array.
    const rev = logs.reverse();
    return (
      <LogWrapper>
        {rev.map((log, i) => {
          return <OneLog key={i} log={log} rule={rule} icons={icons} />;
        })}
      </LogWrapper>
    );
  }
}

const LogWrapper = styled.div`
  display: table;
`;
