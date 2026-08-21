import {useState} from 'react';
import BugReportIcon from '@mui/icons-material/BugReport';
import {submitIssueReport} from '../../services/issuesClient';
import {BugReportModal} from './BugReportModal';

export function BetaFeedbackWidget() {
    const [isModalOpen, setModalOpen] = useState(false);

    return (
        <div className="relative flex items-center">
            <button
                type="button"
                aria-label="Report a bug"
                title="Report a bug"
                className="close window-control-icon"
                onClick={() => setModalOpen(true)}
                onFocus={(event) => event.currentTarget.blur()}
            >
                <BugReportIcon sx={{fontSize: 16}} aria-hidden="true"/>
            </button>
            <BugReportModal
                open={isModalOpen}
                onClose={() => setModalOpen(false)}
                onSubmit={submitIssueReport}
            />
        </div>
    );
}
